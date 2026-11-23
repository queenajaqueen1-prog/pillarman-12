import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Minus, Plus, Trash2, Heart } from "lucide-react";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { useCart } from "../context/CartContext";
import { useAuth } from "../context/AuthContext";
import api from "../api/client";
import { useWishlist } from "../context/WishlistContext";
import { showToast } from "../utils/toast";
import { formatPrice } from "../utils/currency";

// Harus sama dengan nilai di backend (orderController.js)
const DELIVERY_FEE = 15000;
const FREE_DELIVERY_THRESHOLD = 500000;

const getId = (record) => record?._id ?? record?.id;

export default function CartPage() {
  const {
    cartItems,
    updateProductPricing,
    updateQuantity,
    removeItem,
    clearCart,
  } = useCart();
  const { user } = useAuth();
  const { isSaved, toggle: toggleWishlist } = useWishlist();
  const navigate = useNavigate();
  const [savedAddresses, setSavedAddresses] = useState([]);
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [addressError, setAddressError] = useState("");
  const [addressForm, setAddressForm] = useState({
    type: "Home",
    street: "",
    city: "",
    state: "",
    pincode: "",
  });
  const [error, setError] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);
  const [couponInput, setCouponInput] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponSubtotal, setCouponSubtotal] = useState(0);
  const [couponError, setCouponError] = useState("");
  const [wishlistError, setWishlistError] = useState("");
  const productIdsKey = [
    ...new Set(cartItems.map((item) => String(item.productId))),
  ].join(",");

  useEffect(() => {
    if (!productIdsKey) return undefined;
    let active = true;
    const productIds = productIdsKey.split(",");
    Promise.allSettled(
      productIds.map((productId) => api.get(`/products/${productId}`)),
    ).then((results) => {
      if (!active) return;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          updateProductPricing(productIds[index], result.value.data);
        }
      });
    });
    return () => {
      active = false;
    };
  }, [productIdsKey, updateProductPricing]);

  useEffect(() => {
    if (user?.role !== "customer") {
      setSavedAddresses([]);
      setSelectedAddressId("");
      return undefined;
    }
    let active = true;
    api
      .get("/customer/addresses")
      .then(({ data }) => {
        if (!active || !Array.isArray(data)) return;
        setSavedAddresses(data);
        setSelectedAddressId((current) => {
          const kept = data.find((address) => getId(address) === current);
          const preferred = data.find((address) => address.isDefault);
          return getId(kept) || getId(preferred) || getId(data[0]) || "";
        });
      })
      .catch((requestError) => {
        if (active) {
          setAddressError(
            requestError.response?.data?.message ||
              "Unable to load saved addresses.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [user?._id, user?.id, user?.role]);

  const subtotal = cartItems.reduce(
    (total, item) => total + item.price * item.quantity,
    0,
  );
  const deliveryFee =
    subtotal >= FREE_DELIVERY_THRESHOLD || subtotal === 0 ? 0 : DELIVERY_FEE;
  const activeDiscount = couponSubtotal === subtotal ? couponDiscount : 0;

  const applyCoupon = async () => {
    setCouponError("");
    try {
      const { data } = await api.post("/coupons/validate", {
        code: couponInput,
        subtotal,
      });
      setCouponCode(data.code);
      setCouponDiscount(data.discountAmount);
      setCouponSubtotal(subtotal);
    } catch (requestError) {
      setCouponCode("");
      setCouponDiscount(0);
      setCouponError(
        requestError.response?.data?.message || "Unable to validate coupon.",
      );
    }
  };

  const checkout = async (event) => {
    event.preventDefault();
    setError("");
    if (!user) {
      showToast("Sign in to your customer account to continue checkout.", "error");
      navigate("/login");
      return;
    }
    if (user.role !== "customer") {
      const message = "Only customer accounts can place orders.";
      setError(message);
      showToast(message, "error");
      return;
    }
    if (!selectedAddressId) {
      const message = "Select or add a delivery address before checkout.";
      setError(message);
      showToast(message, "error");
      return;
    }
    setCheckingOut(true);
    try {
      const { data } = await api.post("/orders", {
        items: cartItems.map((item) => ({
          product: item.productId,
          quantity: item.quantity,
          selectedSize: item.size,
          selectedColor: item.color,
        })),
        addressId: selectedAddressId,
        couponCode,
      });

      if (data.freeOrder) {
        clearCart();
        navigate("/customer", {
          state: {
            orderEmailNotice: data.confirmationEmailSent
              ? ""
              : "Your order was placed, but we could not send the confirmation email. Please review the order in your account.",
          },
        });
        return;
      }

      if (!window.snap) {
        setError("Midtrans payment service could not be loaded. Refresh and try again.");
        return;
      }
      if (!data.transaction?.token) {
        setError("Midtrans transaction token is missing.");
        return;
      }

      const orderId = getId(data.order);

      window.snap.pay(data.transaction.token, {
        onSuccess: async () => {
          try {
            const { data: verification } = await api.post("/orders/verify", {
              orderId,
            });
            setError("");
            clearCart();
            navigate("/customer", {
              state: {
                orderEmailNotice: verification.confirmationEmailSent
                  ? ""
                  : "Your payment was received, but we could not send the confirmation email. Please review the order in your account.",
              },
            });
          } catch (verifyError) {
            setError(
              verifyError.response?.data?.message ||
                "Payment verification failed. Please check your order in your account.",
            );
          }
        },
        onPending: () => {
          clearCart();
          navigate("/customer", {
            state: {
              orderEmailNotice:
                "Your order was created and is waiting for payment. Complete the payment to confirm it.",
            },
          });
        },
        onError: () => {
          setError("Payment failed. Please try again.");
        },
        onClose: () => {
          setError("You closed the payment window before completing payment.");
        },
      });
    } catch (requestError) {
      const responseMessage =
        requestError.response?.data?.message ||
        requestError.response?.data?.error?.description;
      setError(
        responseMessage ||
          (requestError.response
            ? `Checkout could not be started (HTTP ${requestError.response.status}). Please try again or contact the store administrator.`
            : "Could not reach the checkout server. Check that the backend is running and try again."),
      );
    } finally {
      setCheckingOut(false);
    }
  };

  const saveAddress = async (event) => {
    event.preventDefault();
    setSavingAddress(true);
    setAddressError("");
    try {
      const { data } = await api.post("/customer/addresses", addressForm);
      setSavedAddresses((current) => [...current, data]);
      setSelectedAddressId(getId(data));
      setShowAddressForm(false);
      setAddressForm({
        type: "Home",
        street: "",
        city: "",
        state: "",
        pincode: "",
      });
    } catch (requestError) {
      setAddressError(
        requestError.response?.data?.message || "Unable to save address.",
      );
    } finally {
      setSavingAddress(false);
    }
  };

  const handleWishlistToggle = async (item) => {
    setWishlistError("");
    try {
      await toggleWishlist({
        _id: item.productId,
        title: item.title,
        brand: item.brand,
        price: item.price,
        originalPrice: item.originalPrice,
        images: [item.image],
      });
    } catch (toggleError) {
      setWishlistError(toggleError.message);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Header />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Your cart</h1>
        {cartItems.length === 0 ? (
          <section className="bg-white border rounded-xl p-10 text-center">
            <p className="text-lg font-semibold">Your cart is empty</p>
            <Link to="/category" className="inline-block mt-4 text-blue-600 font-semibold">
              Browse products
            </Link>
          </section>
        ) : (
          <div className="grid lg:grid-cols-3 gap-6 items-start">
            <section className="lg:col-span-2 space-y-3">
              {cartItems.map((item) => (
                <article
                  key={item._id}
                  className="bg-white border rounded-xl p-4 flex gap-4"
                >
                  <img
                    src={item.image}
                    alt={item.title}
                    className="w-24 h-28 object-cover bg-gray-100 rounded-lg"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between gap-3">
                      <div>
                        <h2 className="font-semibold text-gray-900">{item.title}</h2>
                        {item.brand && <p className="text-xs text-gray-500">{item.brand}</p>}
                        {(item.size || item.color) && (
                          <p className="text-xs text-gray-500 mt-1">
                            {[item.size, item.color].filter(Boolean).join(" / ")}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${item.title}`}
                        onClick={() => removeItem(item._id)}
                        className="text-gray-400 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    {user?.role === "customer" && (
                      <button
                        type="button"
                        onClick={() => handleWishlistToggle(item)}
                        className={`mt-2 inline-flex items-center gap-1 text-xs font-semibold ${
                          isSaved(item.productId)
                            ? "text-rose-600"
                            : "text-gray-500 hover:text-rose-600"
                        }`}
                      >
                        <Heart
                          className="h-3.5 w-3.5"
                          fill={isSaved(item.productId) ? "currentColor" : "none"}
                        />
                        {isSaved(item.productId)
                          ? "Remove from wishlist"
                          : "Save to wishlist"}
                      </button>
                    )}
                    <p className="font-bold mt-3">{formatPrice(item.price)}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        type="button"
                        aria-label="Decrease quantity"
                        onClick={() => updateQuantity(item._id, -1)}
                        className="border rounded p-1"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="text-sm">{item.quantity}</span>
                      <button
                        type="button"
                        aria-label="Increase quantity"
                        onClick={() => updateQuantity(item._id, 1)}
                        className="border rounded p-1"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </section>

            <form onSubmit={checkout} className="bg-white border rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-bold text-lg">Delivery address</h2>
                {user?.role === "customer" && (
                  <button
                    type="button"
                    onClick={() => setShowAddressForm((current) => !current)}
                    className="text-xs font-semibold text-blue-600 hover:underline"
                  >
                    {showAddressForm ? "Cancel" : "+ Add address"}
                  </button>
                )}
              </div>
              {!user ? (
                <p className="text-sm text-gray-500">
                  Sign in to select a saved delivery address.
                </p>
              ) : savedAddresses.length ? (
                <fieldset className="space-y-2">
                  <legend className="sr-only">Choose a saved address</legend>
                  {savedAddresses.map((address) => {
                    const addressId = getId(address);
                    return (
                      <label
                        key={addressId}
                        className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${
                          selectedAddressId === addressId
                            ? "border-blue-500 bg-blue-50"
                            : "border-gray-200"
                        }`}
                      >
                        <input
                          type="radio"
                          name="deliveryAddress"
                          checked={selectedAddressId === addressId}
                          onChange={() => setSelectedAddressId(addressId)}
                          className="mt-1 accent-blue-600"
                        />
                        <span>
                          <span className="font-semibold text-gray-900">
                            {address.type}
                            {address.isDefault ? " · Default" : ""}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-gray-600">
                            {address.street}, {address.city}, {address.state},{" "}
                            {address.pincode}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              ) : (
                <p className="text-sm text-gray-500">
                  Add a delivery address to continue.
                </p>
              )}
              {showAddressForm && user?.role === "customer" && (
                <div className="space-y-3 rounded-lg border border-dashed p-3">
                  <label className="block text-sm text-gray-600">
                    Address label
                    <select
                      value={addressForm.type}
                      onChange={(event) =>
                        setAddressForm((current) => ({
                          ...current,
                          type: event.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-gray-900"
                    >
                      <option value="Home">Home</option>
                      <option value="Work">Work</option>
                    </select>
                  </label>
                  {[
                    ["street", "Alamat lengkap"],
                    ["city", "Kota / Kabupaten"],
                    ["state", "Provinsi"],
                    ["pincode", "Kode pos"],
                  ].map(([field, label]) => (
                    <label key={field} className="block text-sm text-gray-600">
                      {label}
                      <input
                        required
                        inputMode={field === "pincode" ? "numeric" : undefined}
                        pattern={field === "pincode" ? "[0-9]{5}" : undefined}
                        title={field === "pincode" ? "Kode pos 5 digit" : undefined}
                        maxLength={
                          field === "street" ? 200 : field === "pincode" ? 5 : 80
                        }
                        value={addressForm[field]}
                        onChange={(event) =>
                          setAddressForm((current) => ({
                            ...current,
                            [field]: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border px-3 py-2 text-gray-900"
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    onClick={saveAddress}
                    disabled={savingAddress}
                    className="w-full rounded-lg border border-blue-600 py-2 text-sm font-semibold text-blue-700 disabled:opacity-60"
                  >
                    {savingAddress ? "Saving..." : "Save and use address"}
                  </button>
                </div>
              )}
              {addressError && (
                <p role="alert" className="text-sm text-red-600">
                  {addressError}
                </p>
              )}
              {wishlistError && (
                <p role="alert" className="text-sm text-red-600">
                  {wishlistError}
                </p>
              )}
              <div className="border-t pt-4">
                <label className="block text-sm text-gray-600">
                  Coupon code
                  <div className="flex gap-2 mt-1">
                    <input
                      value={couponInput}
                      onChange={(event) => setCouponInput(event.target.value)}
                      className="min-w-0 flex-1 border rounded-lg px-3 py-2 uppercase text-gray-900"
                      placeholder="Enter code"
                    />
                    <button
                      type="button"
                      onClick={applyCoupon}
                      className="rounded-lg border px-3 py-2 text-sm font-semibold text-blue-700"
                    >
                      Apply
                    </button>
                  </div>
                </label>
                {couponError && (
                  <p role="alert" className="text-xs text-red-600 mt-2">
                    {couponError}
                  </p>
                )}
                {couponCode && !couponError && (
                  <p className="text-xs text-green-700 mt-2">
                    {couponSubtotal === subtotal
                      ? `${couponCode} applied`
                      : "Cart changed. Re-apply the coupon to refresh the estimate."}
                  </p>
                )}
              </div>
              <div className="border-t pt-4 space-y-2 text-sm">
                <p className="flex justify-between">
                  <span>Subtotal</span>
                  <span>{formatPrice(subtotal)}</span>
                </p>
                <p className="flex justify-between">
                  <span>Delivery</span>
                  <span>{deliveryFee ? formatPrice(deliveryFee) : "Free"}</span>
                </p>
                {activeDiscount > 0 && (
                  <p className="flex justify-between text-green-700">
                    <span>Coupon discount</span>
                    <span>-{formatPrice(activeDiscount)}</span>
                  </p>
                )}
                <p className="flex justify-between font-bold text-base border-t pt-3">
                  <span>Total estimate</span>
                  <span>
                    {formatPrice(Math.max(0, subtotal + deliveryFee - activeDiscount))}
                  </span>
                </p>
                <p className="text-xs text-gray-500">
                  Final product prices and delivery are confirmed by the server at checkout.
                </p>
              </div>
              {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={checkingOut}
                className="w-full rounded-lg bg-blue-600 py-3 font-bold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {checkingOut
                  ? "Starting checkout..."
                  : user
                    ? "Continue to payment"
                    : "Sign in to checkout"}
              </button>
            </form>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}