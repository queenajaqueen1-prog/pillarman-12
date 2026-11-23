import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../config/db.js";

const configs = {
  User: { delegate: "user", refs: {}, json: ["addresses", "wishlist"], defaults: { profileImage: "", role: "customer", sellerApproved: true, isActive: true, tokenVersion: 0, walletBalance: 0, addresses: [], wishlist: [] } },
  Product: { delegate: "product", refs: { seller: "sellerId" }, json: ["images", "sizes", "colors", "colorImages", "specifications"], defaults: { subcategory: "T-Shirts", specialDiscountPercentage: 0, discountPercentage: 0, rating: 0, numReviews: 0, images: [], sizes: [], colors: [], colorImages: [], specifications: { fabric: "100% Cotton", fit: "Regular Fit", pattern: "Solid", sleeve: "Half Sleeve", care: "Machine wash" }, stock: 10 } },
  Order: {
  delegate: "order",
  refs: { customer: "customerId" },
  json: ["items", "shippingAddress", "paymentInfo"],
  defaults: {
    items: [],
    deliveryFee: 0,
    discountAmount: 0,
    orderStatus: "Processing",
    paymentInfo: {
      gateway: "Midtrans",
      status: "Pending"
    },
    shippingAddress: {}
  }
},
  Category: { delegate: "category", refs: {}, json: [], defaults: { isActive: true } },
  Banner: { delegate: "banner", refs: {}, json: [], defaults: { description: "", placement: "side", theme: "blue", sortOrder: 0, isActive: true } },
  Coupon: { delegate: "coupon", refs: {}, json: [], defaults: { maxDiscountAmount: 500, minOrderAmount: 0, startDate: null, isActive: true } },
  InfoPage: { delegate: "infoPage", refs: { updatedBy: "updatedById" }, json: ["sections"], defaults: { sections: [] } },
  NewsletterCampaign: { delegate: "newsletterCampaign", refs: { createdBy: "createdById" }, json: ["banner"], defaults: { message: "", banner: {}, status: "queued", audienceCount: 0, processedCount: 0, sentCount: 0, failedCount: 0, skippedCount: 0 } },
  NewsletterSubscriber: { delegate: "newsletterSubscriber", refs: {}, json: [], defaults: { isSubscribed: true } },
  ProductReview: { delegate: "productReview", refs: { product: "productId", customer: "customerId" }, json: [], defaults: {} },
  SpecialDeal: { delegate: "specialDeal", refs: { product: "productId" }, json: [], defaults: { isActive: true } },
  PasswordResetToken: { delegate: "passwordResetToken", refs: { user: "userId" }, json: [], defaults: {} },
};

const getPath = (obj, path) => {
  const parts = path.split(".");
  const walk = (value, index) => {
    if (value == null) return undefined;
    if (index >= parts.length) return value;
    if (Array.isArray(value)) return value.map((entry) => walk(entry, index));
    return walk(value[parts[index]], index + 1);
  };
  return walk(obj, 0);
};
const setPath = (obj, path, value) => {
  const parts = path.split("."); let target = obj;
  for (const key of parts.slice(0, -1)) target = target[key] ??= {};
  target[parts.at(-1)] = value;
};
const same = (a, b) => String(a) === String(b);

function matchesValue(actual, expected, full = {}) {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ""));
  if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
    for (const [op, value] of Object.entries(expected)) {
      if (op === "$in" && !(value || []).some((v) => Array.isArray(actual) ? actual.some((x) => same(x, v)) : same(actual, v))) return false;
      if (op === "$nin" && (value || []).some((v) => same(actual, v))) return false;
      if (op === "$gt" && !(actual > value)) return false;
      if (op === "$gte" && !(actual >= value)) return false;
      if (op === "$lt" && !(actual < value)) return false;
      if (op === "$lte" && !(actual <= value)) return false;
      if (op === "$ne" && (Array.isArray(actual) ? actual.some((x) => same(x, value)) : same(actual, value))) return false;
      if (op === "$exists" && ((actual !== undefined) !== Boolean(value))) return false;
      if (op === "$regex") {
        const flags = expected.$options || "";
        if (!new RegExp(value, flags).test(String(actual ?? ""))) return false;
      }
      if (op === "$elemMatch" && (!Array.isArray(actual) || !actual.some((item) => matches(item, value)))) return false;
      if (op.startsWith("$" ) && !["$in", "$nin", "$gt", "$gte", "$lt", "$lte", "$ne", "$exists", "$regex", "$options", "$elemMatch"].includes(op)) return false;
    }
    return true;
  }
  if (Array.isArray(actual)) return actual.some((x) => same(x, expected));
  return actual instanceof Date && expected instanceof Date ? actual.getTime() === expected.getTime() : same(actual, expected);
}
function matches(doc, filter = {}) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    if (key === "$or") return expected.some((part) => matches(doc, part));
    if (key === "$and") return expected.every((part) => matches(doc, part));
    if (key === "$nor") return !expected.some((part) => matches(doc, part));
    return matchesValue(getPath(doc, key), expected, filter);
  });
}
function normalizeRefFilter(filter, config) {
  if (!filter || typeof filter !== "object") return filter;
  const out = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$")) out[key] = Array.isArray(value) ? value.map((v) => normalizeRefFilter(v, config)) : value;
    else {
      const first = key.split(".")[0];
      const mapped = config.refs?.[first];
      out[mapped && key === first ? mapped : key] = value;
    }
  }
  return out;
}

function toPrisma(data, config) {
  const out = {};

  for (const [key, value] of Object.entries(data || {})) {
    if (
      ["_id", "id", "__v", "colorImageSelections"].includes(key) ||
      value === undefined
    ) {
      continue;
    }

    const mapped = config.refs?.[key] || key;

    if (key === "password" && value === "") {
      continue;
    }

    out[mapped] =
      config.refs?.[key] && value && typeof value === "object"
        ? (value._id || value.id)
        : cleanValue(value);
  }

  return out;
}


function cloneValue(value) {
  if (value instanceof Document) return plain(value);
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("__")).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}
function plain(doc) {
  const out = {};
  for (const [key, value] of Object.entries(doc || {})) {
    if (key.startsWith("__") || key === "id") continue;
    out[key] = cloneValue(value);
  }
  return out;
}
function cleanValue(value) {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, cleanValue(item)]));
  }
  return value;
}

function attachArrayHelpers(doc, field) {
  const arr = doc[field];
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (item && typeof item === "object") {
      Object.defineProperty(item, "deleteOne", { enumerable: false, value: async () => {
        doc[field] = doc[field].filter((entry) => !same(entry.id, item.id));
      }});
    }
  }
  Object.defineProperty(arr, "id", { enumerable: false, configurable: true, value: (id) => arr.find((item) => same(item.id, id)) });
}

class Document {
  constructor(modelName, data = {}) {
    this.__modelName = modelName;
    this.__config = configs[modelName];
    Object.assign(this, structuredClone(this.__config.defaults || {}), cloneValue(data));
    if (this._id) this.id = this._id;
    if (modelName === "Order") {
      for (const item of this.items || []) if (!item._id) item._id = crypto.randomBytes(12).toString("hex");
    }
    if (modelName === "User") {
      this.email = String(this.email || "").toLowerCase();
      if (this.role === "seller" && !this.sellerCode) this.sellerCode = `SM-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
      for (const address of this.addresses || []) if (!address.id) address.id = crypto.randomBytes(12).toString("hex");
      attachArrayHelpers(this, "addresses");
    }
    this.__originalPassword = this._id ? this.password : undefined;
  }
  async save() {
    const cfg = this.__config;
    const delegate = prisma[cfg.delegate];
    const data = plain(this);
    if (this.__modelName === "Order") {
      for (const item of data.items || []) if (!item._id) item._id = crypto.randomBytes(12).toString("hex");
    }
    if (this.__modelName === "User") {
      data.email = String(data.email || "").toLowerCase();
      if (data.role === "seller" && !data.sellerCode) data.sellerCode = `SM-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
      for (const address of data.addresses || []) if (!address.id) address.id = crypto.randomBytes(12).toString("hex");
      if (data.password && data.password !== this.__originalPassword) data.password = await bcrypt.hash(data.password, 12);
    }
    if (this.__modelName === "NewsletterSubscriber") data.email = String(data.email || "").toLowerCase();
    if (this.__modelName === "Coupon") data.code = String(data.code || "").toUpperCase();
    if (this.__modelName === "Product") {
  // Convert numeric fields from form strings to numbers
  const floatFields = [
    "price",
    "originalPrice",
    "specialDiscountPercentage",
    "discountPercentage",
    "rating",
  ];

  for (const field of floatFields) {
    if (data[field] !== undefined && data[field] !== null) {
      data[field] = Number(data[field]);
    }
  }

  const integerFields = ["stock", "numReviews"];

  for (const field of integerFields) {
    if (data[field] !== undefined && data[field] !== null) {
      data[field] = Number(data[field]);
    }
  }

  // Validate numeric values
  for (const field of [...floatFields, ...integerFields]) {
    if (
      data[field] !== undefined &&
      data[field] !== null &&
      !Number.isFinite(data[field])
    ) {
      throw new Error(`${field} must be a valid number`);
    }
  }

  // Calculate selling price
  if (
    data.specialDiscountPercentage > 0 &&
    data.originalPrice > 0
  ) {
    data.price = Number(
      (
        data.originalPrice *
        (1 - data.specialDiscountPercentage / 100)
      ).toFixed(2)
    );
  }

  // Calculate discount percentage
  data.discountPercentage =
    data.originalPrice > data.price
      ? Math.max(
          1,
          Math.round(
            (1 - data.price / data.originalPrice) * 100
          )
        )
      : 0;
}
    let prismaData = toPrisma(data, cfg);
    delete prismaData.createdAt;
    if (this.__partialFields) {
      const allowed = new Set(this.__partialFields.map((key) => cfg.refs?.[key] || key));
      prismaData = Object.fromEntries(Object.entries(prismaData).filter(([key]) => allowed.has(key)));
    }
    const id = this._id || this.id;
    let row;
    try {
      row = id
        ? await delegate.update({ where: { id }, data: { ...prismaData, updatedAt: new Date() } })
        : await delegate.create({ data: prismaData });
    } catch (error) {
      if (error?.code === "P2002") error.code = "11000";
      throw error;
    }
    Object.assign(this, fromRow(this.__modelName, row));
    this.__originalPassword = this.password;
    attachArrayHelpers(this, "addresses");
    return this;
  }
  async populate(path, selectOrOptions) {
    await populateOne(this, path, selectOrOptions);
    return this;
  }
  toObject() {
    const out = plain(this);
    if (this.__modelName === "User" && !this.__includeGoogleId) delete out.googleId;
    return out;
  }
  toJSON() {
    const out = plain(this);
    if (this.__modelName === "User" && !this.__includeGoogleId) delete out.googleId;
    if (this.__modelName === "Product" && out.originalPrice > out.price) out.discountPercentage = Math.max(1, Math.round((1 - out.price / out.originalPrice) * 100));
    delete out.__modelName; delete out.__config; delete out.__originalPassword;
    return out;
  }
  async matchPassword(value) { return bcrypt.compare(value, this.password); }
  async deleteOne() { return prisma[this.__config.delegate].delete({ where: { id: this._id } }); }
}
function fromRow(modelName, row) {
  if (!row) return null;
  const cfg = configs[modelName]; const out = { ...row, _id: row.id };
  delete out.id;
  for (const [ref, fk] of Object.entries(cfg.refs || {})) { out[ref] = row[fk]; delete out[fk]; }
  const doc = new Document(modelName, out);
  doc._id = row.id; doc.id = row.id;
  return doc;
}

const modelNameByDelegate = Object.fromEntries(Object.entries(configs).map(([k, v]) => [v.delegate, k]));
async function getRelated(modelName, id) {
  if (!id) return null;
  const target = ({ User: "User", Product: "Product", Category: "Category" })[modelName] || modelName;
  const cfg = configs[target]; if (!cfg) return null;
  const row = await prisma[cfg.delegate].findUnique({ where: { id: String(id) } });
  return row ? fromRow(target, row) : null;
}
function pickFields(value, select) {
  if (!select || typeof select !== "string") return value;
  const rawFields = select.split(/\s+/).filter(Boolean);
  if (rawFields.length && rawFields.every((f) => f.startsWith("+"))) return value;
  const fields = rawFields.map((f) => f.startsWith("+") ? f.slice(1) : f);
  const exclusions = fields.filter((f) => f.startsWith("-")).map((f) => f.slice(1));
  if (exclusions.length) { const result = plain(value); for (const f of exclusions) delete result[f]; return result; }
  const result = {};
  for (const f of fields) if (value[f] !== undefined) result[f] = value[f];
  if (value._id !== undefined) result._id = value._id;
  return result;
}

function projectDocument(doc, select) {
  if (!select || typeof select !== "string") return doc;
  const raw = select.split(/\s+/).filter(Boolean);
  if (raw.length && raw.every((f) => f.startsWith("+"))) {
    if (doc.__modelName === "User" && raw.includes("+googleId")) doc.__includeGoogleId = true;
    return doc;
  }
  const fields = raw.map((f) => f.startsWith("+") ? f.slice(1) : f);
  const exclusions = fields.filter((f) => f.startsWith("-")).map((f) => f.slice(1));
  if (exclusions.length) {
    const projected = new Document(doc.__modelName, plain(doc));
    for (const field of exclusions) delete projected[field];
    projected.__partialFields = Object.keys(plain(doc)).filter((field) => !exclusions.includes(field));
    return projected;
  }
  const data = { _id: doc._id };
  for (const field of fields) if (!field.startsWith("-") && doc[field] !== undefined) data[field] = doc[field];
  const projected = new Document(doc.__modelName, data);
  projected.__partialFields = fields.filter((field) => field !== "_id");
  return projected;
}

async function populateOne(doc, pathOrOptions, selectArg) {
  const opts = typeof pathOrOptions === "string" ? { path: pathOrOptions, select: selectArg } : pathOrOptions;
  if (!opts?.path) return;
  const path = opts.path;
  if (path === "seller" || path === "customer" || path === "createdBy" || path === "updatedBy" || path === "product") {
    const target = ({ seller: "User", customer: doc.__modelName === "ProductReview" || doc.__modelName === "Order" ? "User" : "User", createdBy: "User", updatedBy: "User", product: "Product" })[path];
    const related = await getRelated(target, doc[path]);
    if (related && (!opts.match || matches(related, opts.match))) doc[path] = pickFields(related, opts.select);
    else if (opts.match) doc[path] = null;
  } else if (path === "items.product" && Array.isArray(doc.items)) {
    for (const item of doc.items) item.product = await getRelated("Product", item.product);
    if (opts.select) for (const item of doc.items) if (item.product) item.product = pickFields(item.product, opts.select);
  } else if (path === "wishlist" && Array.isArray(doc.wishlist)) {
    let products = await Promise.all(doc.wishlist.map((id) => getRelated("Product", id)));
    products = products.filter(Boolean);
    const options = opts.options || {};
    if (options.sort) {
      const [field, direction] = Object.entries(options.sort)[0] || [];
      if (field) products.sort((a, b) => (a[field] < b[field] ? -1 * direction : a[field] > b[field] ? direction : 0));
    }
    if (options.skip) products = products.slice(options.skip);
    if (options.limit != null) products = products.slice(0, options.limit);
    if (opts.populate) for (const product of products) await populateOne(product, opts.populate);
    doc.wishlist = products.map((p) => opts.select ? pickFields(p, opts.select) : p);
  }
}

class Query {
  constructor(modelName, filter, one = false) { this.modelName = modelName; this.filter = filter || {}; this.one = one; this.projection = null; this.sortSpec = null; this.offset = 0; this.take = null; this.populates = []; this.asLean = false; }
  select(value) { this.projection = value; return this; }
  sort(value) { this.sortSpec = value; return this; }
  skip(value) { this.offset = Number(value) || 0; return this; }
  limit(value) { this.take = Number(value); return this; }
  lean() { this.asLean = true; return this; }
  populate(path, select) { this.populates.push(typeof path === "string" ? { path, select } : path); return this; }
  async exec() {
    const cfg = configs[this.modelName];
    let rows = await prisma[cfg.delegate].findMany();
    let docs = rows.map((r) => fromRow(this.modelName, r)).filter((d) => matches(d, this.filter));
    if (this.sortSpec) {
      const entries = Object.entries(this.sortSpec);
      docs.sort((a, b) => { for (const [field, direction] of entries) { const av = getPath(a, field), bv = getPath(b, field); if (av < bv) return -1 * direction; if (av > bv) return 1 * direction; } return 0; });
    }
    if (this.one) docs = docs.slice(0, 1);
    if (this.offset) docs = docs.slice(this.offset);
    if (this.take != null && this.take >= 0) docs = docs.slice(0, this.take);
    for (const doc of docs) for (const p of this.populates) await populateOne(doc, p);
    const values = docs.map((doc) => {
      let value = this.projection ? projectDocument(doc, this.projection) : doc;
      if (this.asLean) value = plain(value);
      return value;
    });
    return this.one ? values[0] || null : values;
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
  cursor() {
    const query = this;
    return (async function* () { const rows = await query.exec(); for (const row of (Array.isArray(rows) ? rows : rows ? [rows] : [])) yield row; })();
  }
}

function applyUpdate(current, update) {
  const data = {};
  if (!Object.keys(update || {}).some((key) => key.startsWith("$"))) return { ...current, ...update };
  const next = plain(current);
  for (const [operator, values] of Object.entries(update || {})) {
    if (operator === "$set") for (const [k, v] of Object.entries(values)) setPath(next, k, v);
    if (operator === "$inc") for (const [k, v] of Object.entries(values)) setPath(next, k, Number(getPath(next, k) || 0) + Number(v));
    if (operator === "$unset") for (const k of Object.keys(values)) setPath(next, k, undefined);
    if (operator === "$addToSet") for (const [k, v] of Object.entries(values)) { const arr = getPath(next, k) || []; const items = v?.$each || [v]; for (const item of items) if (!arr.some((x) => same(x, item))) arr.push(item); setPath(next, k, arr); }
    if (operator === "$pull") for (const [k, v] of Object.entries(values)) { const arr = getPath(next, k) || []; setPath(next, k, arr.filter((item) => !matchesValue(item, v))); }
  }
  return next;
}

export function createLegacyModel(modelName) {
  const cfg = configs[modelName];
  if (!cfg) throw new Error(`Unknown model: ${modelName}`);
  return class extends Document {
    constructor(data = {}) { super(modelName, data); }
    static find(filter = {}) { return new Query(modelName, filter); }
    static findOne(filter = {}) { return new Query(modelName, filter, true); }
    static findById(id) { return new Query(modelName, { _id: id }, true); }
    static async create(data) { const doc = new this(data); await doc.save(); return doc; }
    static async countDocuments(filter = {}) { const rows = await new Query(modelName, filter).exec(); return rows.length; }
    static async exists(filter = {}) { const row = await new Query(modelName, filter, true).exec(); return row ? { _id: row._id } : null; }
    static async updateOne(filter, update) { const doc = await new Query(modelName, filter, true).exec(); if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }; Object.assign(doc, applyUpdate(doc, update)); await doc.save(); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; }
    static async updateMany(filter, update) { const docs = await new Query(modelName, filter).exec(); for (const doc of docs) { Object.assign(doc, applyUpdate(doc, update)); await doc.save(); } return { acknowledged: true, matchedCount: docs.length, modifiedCount: docs.length }; }
    static async findOneAndUpdate(filter, update, options = {}) {
      let doc = await new Query(modelName, filter, true).exec();
      if (!doc && options.upsert) {
        const seed = { ...filter, ...(update?.$set || {}) };
        doc = new this(seed);
        await doc.save();
        return doc;
      }
      if (!doc) return null;
      const old = plain(doc);
      Object.assign(doc, applyUpdate(doc, update));
      await doc.save();
      return options.new || options.returnDocument === "after" ? doc : old;
    }
    static async findByIdAndUpdate(id, update, options = {}) { return this.findOneAndUpdate({ _id: id }, update, options); }
    static async findByIdAndDelete(id) { const doc = await new Query(modelName, { _id: id }, true).exec(); if (!doc) return null; await prisma[cfg.delegate].delete({ where: { id: doc._id } }); return doc; }
    static async findOneAndDelete(filter) { const doc = await new Query(modelName, filter, true).exec(); if (!doc) return null; await prisma[cfg.delegate].delete({ where: { id: doc._id } }); return doc; }
    static async deleteMany(filter = {}) { const docs = await new Query(modelName, filter).exec(); if (docs.length) await prisma[cfg.delegate].deleteMany({ where: { id: { in: docs.map((d) => d._id) } } }); return { acknowledged: true, deletedCount: docs.length }; }
    static async deleteOne(filter = {}) { const doc = await new Query(modelName, filter, true).exec(); if (!doc) return { deletedCount: 0 }; await prisma[cfg.delegate].delete({ where: { id: doc._id } }); return { deletedCount: 1 }; }
  };
}
