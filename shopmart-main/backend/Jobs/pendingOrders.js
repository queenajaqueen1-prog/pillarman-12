import { expirePendingOrders } from "../controllers/orderController.js";

const INTERVAL_MS = 10 * 60 * 1000; // setiap 10 menit
let running = false;

export const startPendingOrderSweeper = () => {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await expirePendingOrders();
      if (summary.checked > 0) {
        console.log("SHOPMART penyapu pesanan pending:", JSON.stringify(summary));
      }
    } catch (error) {
      console.error("SHOPMART penyapu pesanan pending gagal:", error.message);
    } finally {
      running = false;
    }
  };

  setTimeout(run, 30 * 1000); // sekali setelah server hidup
  const timer = setInterval(run, INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
};