import { prisma } from "../config/db.js";
import midtransClient from "midtrans-client";
import crypto from "crypto";

import { calculateCouponDiscount } from "../utils/coupon.js";
import {
  isEmailConfigured,
  sendOrderConfirmationEmail,
} from "../utils/email.js";
import {
  getLiveSpecialDeals,
  getSpecialDealPrice,
} from "../utils/specialDeals.js";

const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// Harus sama dengan nilai di CartPage.jsx
const DELIVERY_FEE = 15000;
const FREE_DELIVERY_THRESHOLD = 500000;

// Batas waktu bayar (menit). Default 24 jam. Bisa diubah lewat .env
const PENDING_TTL_MINUTES = Number(process.env.PENDING_ORDER_TTL_MINUTES) || 1440;
// Jeda tambahan sebelum penyapu bertindak, memberi waktu webhook Midtrans masuk lebih dulu
const SWEEP_GRACE_MINUTES =
  process.env.PENDING_ORDER_GRACE_MINUTES !== undefined
    ? Number(process.env.PENDING_ORDER_GRACE_MINUTES)
    : 10;

const asArray = (value) => (Array.isArray(value) ? value : []);
const isId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 64;
const userIdOf = (req) => String(req.user.id ?? req.user._id);
// Frontend memakai _id, sedangkan Prisma mengembalikan id
const withLegacyId = (order) => (order ? { ...order, _id: order.id } : order);

const isPaidStatus = (midtrans) =>
  midtrans.transaction_status === "settlement" ||
  (midtrans.transaction_status === "capture" && midtrans.fraud_status === "accept");

const isNotFound = (error) => {
  const code = error?.httpStatusCode ?? error?.ApiResponse?.status_code;
  return (
    String(code) === "404" ||
    /doesn.t exist|not found/i.test(String(error?.message || ""))
  );
};

const notifyOrderConfirmation = async (order, customer) => {
  if (!isEmailConfigured()) {
    console.warn("SHOPMART SMTP is not configured; order confirmation email was not sent.");
    return false;
  }
  try {
    await sendOrderConfirmationEmail({
      name: customer.name,
      email: customer.email,
      order: withLegacyId(order),
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { confirmationEmailSentAt: new Date() },
    });
    return true;
  } catch {
    console.error("SHOPMART order confirmation email delivery failed.");
    return false;
  }
};

// Dipakai verifyPayment, webhook, penyapu, dan pembatalan. Hanya satu pemanggil
// yang berhasil "mengklaim" pesanan, jadi stok tidak berkurang dua kali.
const markOrderPaid = async (order, midtrans) => {
  const { snapToken, ...restPayment } = order.paymentInfo || {};
  const updatedPayment = {
    ...restPayment,
    status: "Completed",
    midtransTransactionId: midtrans.transaction_id,
    paymentType: midtrans.payment_type,
    transactionStatus: midtrans.transaction_status,
    paidAt: new Date().toISOString(),
  };

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id,
        paymentInfo: { path: "$.status", not: "Completed" },
      },
      data: {
        paymentInfo: updatedPayment,
        // Pesanan yang sempat dibatalkan lalu ternyata dibayar dihidupkan kembali
        orderStatus: order.orderStatus === "Cancelled" ? "Processing" : order.orderStatus,
      },
    });
    if (claimed.count === 0) return { claimed: false, order: null };

    for (const item of asArray(order.items)) {
      const productId = String(item.product ?? item.productId ?? "");
      const quantity = Number(item.quantity) || 0;
      if (!productId || quantity < 1) continue;
      const decremented = await tx.product.updateMany({
        where: { id: productId, stock: { gte: quantity } },
        data: { stock: { decrement: quantity } },
      });
      if (decremented.count === 0) {
        console.warn(
          "SHOPMART stok tidak cukup untuk produk " + productId + " pada pesanan " + order.id,
        );
      }
    }

    const fresh = await tx.order.findUnique({ where: { id: order.id } });
    return { claimed: true, order: fresh };
  });
};

// Menandai pesanan Pending menjadi gagal/dibatalkan. Hanya menyentuh yang masih Pending.
// Stok tidak perlu dikembalikan karena stok baru berkurang saat pembayaran lunas.
const markOrderFailed = async (order, transactionStatus) => {
  const { snapToken, ...restPayment } = order.paymentInfo || {};
  const result = await prisma.order.updateMany({
    where: {
      id: order.id,
      paymentInfo: { path: "$.status", equals: "Pending" },
    },
    data: {
      orderStatus: "Cancelled",
      paymentInfo: {
        ...restPayment,
        status: "Failed",
        transactionStatus,
        failedAt: new Date().toISOString(),
      },
    },
  });
  return result.count > 0;
};

const finalizePaidOrder = async (order, midtrans) => {
  const result = await markOrderPaid(order, midtrans);
  if (result.claimed) {
    const customer = await prisma.user.findUnique({
      where: { id: order.customerId },
    });
    if (customer) await notifyOrderConfirmation(result.order, customer);
  }
  return result;
};

export const createOrder = async (req, res, next) => {
  try {
    const { items, addressId, couponCode } = req.body;
    const userId = userIdOf(req);

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "At least one item is required" });
    }
    if (!isId(addressId)) {
      return res.status(400).json({ message: "Select a saved delivery address" });
    }

    const customer = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, addresses: true },
    });
    const shippingAddress = asArray(customer?.addresses).find(
      (address) => String(address._id ?? address.id) === addressId,
    );
    if (!shippingAddress) {
      return res.status(400).json({ message: "The selected delivery address is unavailable" });
    }

    if (
      items.some(
        (item) =>
          !item ||
          !isId(item.product) ||
          !Number.isInteger(Number(item.quantity)) ||
          Number(item.quantity) < 1 ||
          Number(item.quantity) > 99,
      )
    ) {
      return res.status(400).json({ message: "One or more cart items are invalid" });
    }

    const productIds = [...new Set(items.map((item) => String(item.product)))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    const productById = new Map(products.map((product) => [product.id, product]));
    const activeDeals = await getLiveSpecialDeals(productIds);
    const dealByProduct = new Map(
      asArray(activeDeals).map((deal) => [String(deal.productId ?? deal.product), deal]),
    );

    const orderItems = [];
    for (const item of items) {
      const product = productById.get(String(item.product));
      const quantity = Number(item.quantity);
      if (!product) {
        return res.status(400).json({ message: "A product in your cart is no longer available" });
      }
      if (product.stock < quantity) {
        return res.status(400).json({ message: product.title + " does not have enough stock" });
      }

      const sizes = asArray(product.sizes);
      const colors = asArray(product.colors);
      const images = asArray(product.images);
      const colorImageGroups = asArray(product.colorImages);

      if (sizes.length && !sizes.includes(item.selectedSize)) {
        return res.status(400).json({ message: "Select a valid size for " + product.title });
      }
      if (colors.length && !colors.includes(item.selectedColor)) {
        return res.status(400).json({ message: "Select a valid color for " + product.title });
      }

      const activeDeal = dealByProduct.get(product.id);
      const colorImages = colorImageGroups.find(
        (group) => group.color === item.selectedColor,
      )?.images;
      const assignedColorImages = colorImageGroups.flatMap((group) => group.images || []);
      const sharedImage = images.find((image) => !assignedColorImages.includes(image));

      orderItems.push({
        product: product.id,
        title: product.title,
        image: colorImages?.[0] || sharedImage || images[0],
        price: activeDeal
          ? getSpecialDealPrice(product.price, activeDeal.discountPercentage)
          : product.price,
        quantity,
        selectedSize: item.selectedSize || null,
        selectedColor: item.selectedColor || null,
        seller: product.sellerId,
      });
    }

    const subtotal = orderItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const deliveryFee =
      subtotal > 0 && subtotal < FREE_DELIVERY_THRESHOLD ? DELIVERY_FEE : 0;
    const { coupon, discountAmount } = await calculateCouponDiscount(
      couponCode,
      subtotal,
    );
    const totalAmount = Math.max(0, subtotal + deliveryFee - discountAmount);
    const freeOrder = totalAmount === 0;

    const order = await prisma.order.create({
      data: {
        customerId: userId,
        items: orderItems,
        shippingAddress: {
          type: shippingAddress.type,
          street: shippingAddress.street,
          city: shippingAddress.city,
          state: shippingAddress.state,
          pincode: shippingAddress.pincode,
        },
        subtotal,
        deliveryFee,
        discountAmount,
        couponCode: coupon?.code ?? null,
        totalAmount,
        paymentInfo: {
          gateway: freeOrder ? "Coupon" : "Midtrans",
          status: freeOrder ? "Completed" : "Pending",
        },
      },
    });

    let transaction = null;
    let savedOrder = order;
    if (!freeOrder) {
      const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000);
      try {
        transaction = await snap.createTransaction({
          transaction_details: {
            order_id: order.id,
            gross_amount: Math.round(totalAmount),
          },
          customer_details: {
            first_name: customer.name || "Customer",
            email: customer.email,
          },
          // Midtrans otomatis menandai transaksi kedaluwarsa dan mengirim webhook "expire"
          expiry: { unit: "minutes", duration: PENDING_TTL_MINUTES },
        });
      } catch (error) {
        // Jangan biarkan pesanan tanpa transaksi menggantung sebagai Pending
        await markOrderFailed(order, "failure");
        throw error;
      }
      savedOrder = await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentInfo: {
            ...(order.paymentInfo || {}),
            snapToken: transaction.token,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
    }

    const confirmationEmailSent = freeOrder
      ? await notifyOrderConfirmation(order, customer)
      : false;

    res.status(201).json({
      success: true,
      order: withLegacyId(savedOrder),
      transaction,
      freeOrder,
      confirmationEmailSent,
    });
  } catch (error) {
    next(error);
  }
};

export const verifyPayment = async (req, res, next) => {
  try {
    const { orderId } = req.body;
    const userId = userIdOf(req);

    if (!isId(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
    });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const paymentInfo = order.paymentInfo || {};

    if (paymentInfo.status === "Completed") {
      return res.json({
        success: true,
        order: withLegacyId(order),
        confirmationEmailSent: Boolean(order.confirmationEmailSentAt),
      });
    }
    if (paymentInfo.gateway !== "Midtrans") {
      return res.status(400).json({ success: false, message: "Invalid payment gateway" });
    }

    const midtransStatus = await snap.transaction.status(order.id);

    if (!isPaidStatus(midtransStatus)) {
      return res.status(400).json({
        success: false,
        message: "Payment has not been completed",
        transactionStatus: midtransStatus.transaction_status,
      });
    }

    const result = await markOrderPaid(order, midtransStatus);
    const completedOrder =
      result.order ?? (await prisma.order.findUnique({ where: { id: order.id } }));

    let confirmationEmailSent = Boolean(completedOrder?.confirmationEmailSentAt);
    if (result.claimed) {
      const customer = await prisma.user.findUnique({ where: { id: userId } });
      confirmationEmailSent = customer
        ? await notifyOrderConfirmation(completedOrder, customer)
        : false;
    }

    res.json({
      success: true,
      message: "Payment verified successfully",
      order: withLegacyId(completedOrder),
      confirmationEmailSent,
    });
  } catch (error) {
    next(error);
  }
};

// Lanjutkan pembayaran pesanan Pending: mengembalikan token Snap yang masih berlaku
export const getPendingPaymentToken = async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    if (!isId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
    });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const paymentInfo = order.paymentInfo || {};
    if (paymentInfo.gateway !== "Midtrans" || paymentInfo.status !== "Pending") {
      return res
        .status(400)
        .json({ success: false, message: "Pesanan ini tidak sedang menunggu pembayaran" });
    }

    const expiresAt = paymentInfo.expiresAt ? new Date(paymentInfo.expiresAt) : null;
    if (!paymentInfo.snapToken || !expiresAt || expiresAt.getTime() <= Date.now()) {
      await markOrderFailed(order, "expire");
      return res.status(409).json({
        success: false,
        message: "Waktu pembayaran sudah habis. Silakan buat pesanan baru.",
      });
    }

    res.json({
      success: true,
      token: paymentInfo.snapToken,
      order: withLegacyId(order),
    });
  } catch (error) {
    next(error);
  }
};

// Batalkan pesanan yang belum dibayar
export const cancelPendingOrder = async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    if (!isId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: userId },
    });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const paymentInfo = order.paymentInfo || {};
    if (paymentInfo.gateway !== "Midtrans" || paymentInfo.status !== "Pending") {
      return res
        .status(400)
        .json({ success: false, message: "Hanya pesanan yang belum dibayar yang bisa dibatalkan" });
    }

    // Cek dulu ke Midtrans, siapa tahu pembayaran baru saja masuk
    let midtrans = null;
    try {
      midtrans = await snap.transaction.status(order.id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    if (midtrans && isPaidStatus(midtrans)) {
      await finalizePaidOrder(order, midtrans);
      return res.status(409).json({
        success: false,
        message: "Pembayaran sudah diterima, pesanan tidak bisa dibatalkan",
      });
    }

    const status = midtrans?.transaction_status;
    if (status === "pending") {
      try {
        await snap.transaction.expire(order.id);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    } else if (status && !["deny", "cancel", "expire", "failure"].includes(status)) {
      return res.status(409).json({
        success: false,
        message: "Pembayaran sedang diproses, coba lagi beberapa saat",
      });
    }

    await markOrderFailed(order, "cancel");
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    res.json({
      success: true,
      message: "Pesanan dibatalkan",
      order: withLegacyId(updated),
    });
  } catch (error) {
    next(error);
  }
};

// Penyapu: dijalankan berkala oleh jobs/pendingOrders.js. Memeriksa pesanan Pending
// yang sudah lewat batas waktu, lalu menandainya lunas atau gagal sesuai status di Midtrans.
export const expirePendingOrders = async () => {
  const ageMs = (PENDING_TTL_MINUTES + SWEEP_GRACE_MINUTES) * 60 * 1000;
  const cutoff = new Date(Date.now() - ageMs);
  const candidates = await prisma.order.findMany({
    where: {
      createdAt: { lt: cutoff },
      paymentInfo: { path: "$.status", equals: "Pending" },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  const summary = { checked: 0, paid: 0, expired: 0, skipped: 0 };
  for (const order of candidates) {
    if ((order.paymentInfo || {}).gateway !== "Midtrans") {
      summary.skipped += 1;
      continue;
    }
    summary.checked += 1;
    try {
      let midtrans = null;
      try {
        midtrans = await snap.transaction.status(order.id);
      } catch (error) {
        // 404: pelanggan menutup popup sebelum memilih metode, transaksi tidak pernah dibuat
        if (!isNotFound(error)) throw error;
      }

      if (midtrans && isPaidStatus(midtrans)) {
        await finalizePaidOrder(order, midtrans);
        summary.paid += 1;
        continue;
      }

      const status = midtrans?.transaction_status;
      if (status === "pending") {
        try {
          await snap.transaction.expire(order.id);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      } else if (status && !["deny", "cancel", "expire", "failure"].includes(status)) {
        // authorize/challenge dan sejenisnya: biarkan, periksa lagi pada putaran berikutnya
        summary.skipped += 1;
        continue;
      }

      const finalStatus = !status || status === "pending" ? "expire" : status;
      if (await markOrderFailed(order, finalStatus)) summary.expired += 1;
    } catch (error) {
      summary.skipped += 1;
      console.warn(
        "SHOPMART gagal memeriksa pesanan pending " + order.id + ": " + error.message,
      );
    }
  }
  return summary;
};

// Webhook dari Midtrans. Route-nya publik (tanpa login), keamanannya di signature.
export const handleMidtransNotification = async (req, res) => {
  try {
    const body = req.body || {};
    const order_id = body.order_id;
    const status_code = body.status_code;
    const gross_amount = body.gross_amount;
    const signature_key = body.signature_key;
    const transaction_status = body.transaction_status;

    const required = [order_id, status_code, gross_amount, signature_key];
    if (!required.every((value) => typeof value === "string" && value.length > 0)) {
      return res.status(400).json({ message: "Invalid notification" });
    }

    // 1. Verifikasi signature dari Midtrans
    const serverKey = process.env.MIDTRANS_SERVER_KEY || "";
    const expected = crypto
      .createHash("sha512")
      .update(order_id + status_code + gross_amount + serverKey)
      .digest("hex");
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature_key);
    if (
      expectedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      return res.status(403).json({ message: "Invalid signature" });
    }

    // 2. Cari pesanan. Pesanan tidak dikenal dijawab 200 agar Midtrans tidak mengulang terus
    const order = await prisma.order.findUnique({ where: { id: order_id } });
    if (!order) return res.status(200).json({ ok: true, ignored: "order not found" });
    if ((order.paymentInfo || {}).gateway !== "Midtrans") {
      return res.status(200).json({ ok: true, ignored: "not a Midtrans order" });
    }

    // 3. Nominal harus cocok dengan total pesanan
    if (Math.round(Number(gross_amount)) !== Math.round(order.totalAmount)) {
      console.error("SHOPMART nominal Midtrans tidak cocok untuk pesanan " + order.id);
      return res.status(400).json({ message: "Amount mismatch" });
    }

    const isFailed = ["deny", "cancel", "expire", "failure"].includes(transaction_status);

    if (isPaidStatus(body)) {
      await finalizePaidOrder(order, body);
    } else if (isFailed) {
      // Pesanan yang sudah lunas tidak pernah diturunkan statusnya
      await markOrderFailed(order, transaction_status);
    }
    // Status lain (pending, challenge) hanya dikonfirmasi diterima

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("SHOPMART Midtrans notification error:", error.message);
    // 500 membuat Midtrans mencoba mengirim ulang
    return res.status(500).json({ message: "Notification handling failed" });
  }
};

export const getCustomerOrders = async (req, res, next) => {
  try {
    const customerId = userIdOf(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

    const [total, orders] = await Promise.all([
      prisma.order.count({ where: { customerId } }),
      prisma.order.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.json({
      success: true,
      orders: orders.map(withLegacyId),
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};

export const getSellerOrders = async (req, res, next) => {
  try {
    const sellerId = userIdOf(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

    const orders = await prisma.order.findMany({
      include: { customer: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });

    const sellerOrders = orders
      .filter((order) => order.paymentInfo?.status === "Completed")
      .map((order) => ({
        ...withLegacyId(order),
        customer: order.customer
          ? { ...order.customer, _id: order.customer.id }
          : order.customer,
        items: asArray(order.items).filter(
          (item) => String(item.seller ?? item.sellerId) === sellerId,
        ),
      }))
      .filter((order) => order.items.length > 0);

    const total = sellerOrders.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const paged = sellerOrders.slice((page - 1) * limit, page * limit);

    res.json({
      success: true,
      orders: paged,
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};