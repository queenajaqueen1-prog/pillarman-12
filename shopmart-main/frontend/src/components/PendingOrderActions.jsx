import { useState } from "react";
import api from "../api/client";

const getId = (record) => record?._id ?? record?.id;

// Tampil hanya untuk pesanan Midtrans yang masih menunggu pembayaran
export default function PendingOrderActions({ order, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const payment = order?.paymentInfo || {};
  if (payment.gateway !== "Midtrans" || payment.status !== "Pending") return null;

  const orderId = getId(order);

  const cancelOrder = async () => {
    if (!window.confirm("Batalkan pesanan ini? Pesanan yang dibatalkan tidak bisa dipulihkan.")) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await api.post(`/orders/${orderId}/cancel`);
      onChanged?.();
    } catch (error) {
      setMessage(error.response?.data?.message || "Pesanan tidak bisa dibatalkan.");
      // Status mungkin sudah berubah (misalnya baru dibayar), muat ulang daftar
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const payNow = async () => {
    setMessage("");
    if (!window.snap) {
      setMessage("Layanan pembayaran belum termuat. Muat ulang halaman lalu coba lagi.");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${orderId}/pay`);
      window.snap.pay(data.token, {
        onSuccess: async () => {
          try {
            await api.post("/orders/verify", { orderId });
          } catch {
            // Webhook Midtrans akan menyelesaikannya
          }
          onChanged?.();
        },
        onPending: () => onChanged?.(),
        onError: () => setMessage("Pembayaran gagal. Silakan coba lagi."),
        onClose: () => {},
      });
    } catch (error) {
      setMessage(
        error.response?.data?.message || "Pembayaran tidak bisa dilanjutkan.",
      );
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={payNow}
          disabled={busy}
          className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          Bayar sekarang
        </button>
        <button
          type="button"
          onClick={cancelOrder}
          disabled={busy}
          className="rounded-lg border border-red-300 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-60"
        >
          Batalkan pesanan
        </button>
      </div>
      {message && (
        <p role="alert" className="text-xs text-red-600">
          {message}
        </p>
      )}
    </div>
  );
}