import crypto from "crypto";
import { prisma } from "../config/db.js";

const userIdOf = (req) => String(req.user.id ?? req.user._id);
const asArray = (value) => (Array.isArray(value) ? value : []);
const isId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 64;

// Frontend memakai _id, sedangkan Prisma mengembalikan id
const withLegacyId = (product) => ({
  ...product,
  _id: product.id,
  seller: product.seller ? { ...product.seller, _id: product.seller.id } : product.seller,
});

// Nama field tetap (street, city, state, pincode) agar cocok dengan data dan frontend
const ADDRESS_FIELDS = {
  street: { label: "Alamat lengkap", maximum: 200 },
  city: { label: "Kota / Kabupaten", maximum: 80 },
  state: { label: "Provinsi", maximum: 80 },
  pincode: { label: "Kode pos", maximum: 5 },
};

const parseAddress = (body) => {
  if (body.type !== undefined && !["Home", "Work"].includes(body.type)) {
    return { error: "Label alamat harus Home atau Work" };
  }
  const type = body.type === "Work" ? "Work" : "Home";
  const address = { type };
  for (const [field, { label, maximum }] of Object.entries(ADDRESS_FIELDS)) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return { error: `${label} wajib diisi` };
    }
    address[field] = body[field].trim();
    if (address[field].length > maximum) {
      return { error: `${label} maksimal ${maximum} karakter` };
    }
  }
  if (!/^[0-9]{5}$/.test(address.pincode)) {
    return { error: "Masukkan kode pos 5 digit yang valid" };
  }
  return { address };
};

const loadUser = (req, select) =>
  prisma.user.findUnique({ where: { id: userIdOf(req) }, select });

/* ---------------------------- Addresses ---------------------------- */

export const getAddresses = async (req, res, next) => {
  try {
    const user = await loadUser(req, { addresses: true });
    res.json(asArray(user?.addresses));
  } catch (error) {
    next(error);
  }
};

export const createAddress = async (req, res, next) => {
  try {
    const user = await loadUser(req, { addresses: true });
    const addresses = asArray(user?.addresses);
    if (addresses.length >= 10) {
      return res.status(400).json({ message: "Maksimal 10 alamat tersimpan" });
    }
    const result = parseAddress(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    const isDefault = addresses.length === 0 || req.body.isDefault === true;
    const updated = isDefault
      ? addresses.map((address) => ({ ...address, isDefault: false }))
      : [...addresses];
    const created = { _id: crypto.randomUUID(), ...result.address, isDefault };
    updated.push(created);

    await prisma.user.update({
      where: { id: userIdOf(req) },
      data: { addresses: updated },
    });
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
};

export const deleteAddress = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) {
      return res.status(400).json({ message: "ID alamat tidak valid" });
    }
    const user = await loadUser(req, { addresses: true });
    const addresses = asArray(user?.addresses);
    const target = addresses.find((a) => String(a._id) === req.params.id);
    if (!target) return res.status(404).json({ message: "Alamat tidak ditemukan" });

    const remaining = addresses.filter((a) => String(a._id) !== req.params.id);
    if (target.isDefault && remaining.length) {
      remaining[0] = { ...remaining[0], isDefault: true };
    }
    await prisma.user.update({
      where: { id: userIdOf(req) },
      data: { addresses: remaining },
    });
    res.json({ message: "Alamat dihapus", addresses: remaining });
  } catch (error) {
    next(error);
  }
};

/* ----------------------------- Wishlist ----------------------------- */

export const getWishlist = async (req, res, next) => {
  try {
    const pageProvided = req.query.page !== undefined;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));

    const user = await loadUser(req, { wishlist: true });
    const ids = asArray(user?.wishlist).map(String);

    // Terbaru lebih dulu untuk mode halaman, sama seperti sort _id: -1 di versi lama
    const orderedIds = pageProvided ? [...ids].reverse() : ids;
    const pageIds = pageProvided
      ? orderedIds.slice((page - 1) * limit, page * limit)
      : orderedIds;

    const products = await prisma.product.findMany({
      where: { id: { in: pageIds } },
      include: { seller: { select: { id: true, name: true } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const wishlist = pageIds.map((id) => byId.get(id)).filter(Boolean).map(withLegacyId);

    if (!pageProvided) {
      // Bersihkan produk yang sudah dihapus dari wishlist
      if (wishlist.length !== ids.length) {
        await prisma.user.update({
          where: { id: userIdOf(req) },
          data: { wishlist: wishlist.map((p) => p.id) },
        });
      }
      return res.json(wishlist);
    }

    res.json({
      wishlist,
      pagination: {
        page,
        limit,
        total: ids.length,
        totalPages: Math.ceil(ids.length / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const addWishlistItem = async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!isId(productId)) {
      return res.status(400).json({ message: "Invalid product id" });
    }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const user = await loadUser(req, { wishlist: true });
    const ids = asArray(user?.wishlist).map(String);
    if (!ids.includes(product.id)) {
      await prisma.user.update({
        where: { id: userIdOf(req) },
        data: { wishlist: [...ids, product.id] },
      });
    }
    res.json({ message: "Product added to wishlist", productId: product.id });
  } catch (error) {
    next(error);
  }
};

export const removeWishlistItem = async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!isId(productId)) {
      return res.status(400).json({ message: "Invalid product id" });
    }
    const user = await loadUser(req, { wishlist: true });
    const ids = asArray(user?.wishlist).map(String);
    await prisma.user.update({
      where: { id: userIdOf(req) },
      data: { wishlist: ids.filter((id) => id !== productId) },
    });
    res.json({ message: "Product removed from wishlist" });
  } catch (error) {
    next(error);
  }
};