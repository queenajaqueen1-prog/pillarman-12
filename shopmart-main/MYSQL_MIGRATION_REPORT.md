# SHOPMART: MongoDB/Mongoose to MySQL/Prisma migration

## Included changes

- Replaced the Mongoose dependency with `@prisma/client` and Prisma CLI.
- Added `backend/prisma/schema.prisma` with 12 MySQL models: User, Product, Order, Category, Banner, Coupon, InfoPage, NewsletterCampaign, NewsletterSubscriber, ProductReview, SpecialDeal, and PasswordResetToken.
- Added a Prisma singleton and MySQL connection check in `backend/config/db.js`.
- Repointed all existing model imports to a Prisma-backed compatibility repository in `backend/lib/legacyModel.js`.
- Replaced MongoDB ObjectId validation with string-ID validation suitable for Prisma CUID IDs.
- Reworked the two MongoDB aggregation use cases (admin metrics and product review summaries) into MySQL-backed application calculations.
- Kept existing API route files, frontend source, request field names, response `_id` fields, JWT flow, Google OAuth, image uploads, newsletter workflow, and Razorpay integration in place.
- Added configurable `CORS_ORIGINS` and updated backend/frontend `.env.example` files.
- Updated README setup, database, migration, and deployment instructions.

## Important implementation detail

Nested document data that was previously stored in MongoDB arrays/subdocuments is represented with MySQL JSON columns in this compatibility migration (for example user addresses/wishlist, product option arrays, order line-item snapshots, shipping address, payment information, and info-page sections). Core entities and their principal references are represented by relational tables and foreign keys.

The compatibility repository intentionally preserves the existing controller/model call shapes to minimize API changes. Some legacy-style filters and pagination are evaluated in application memory after loading rows from Prisma. This is a migration bridge for a small demo/school deployment, not the final high-scale query architecture. Before production use with large datasets, convert controllers to direct Prisma `where`, `orderBy`, `skip`, `take`, `include`, and transaction queries.

## Validation performed in this environment

- All backend JavaScript files passed `node --check`.
- `backend/package.json` parsed as valid JSON.
- No active Mongoose imports or `MONGO_URI` references remain in backend source.
- Prisma dependency installation and Prisma schema validation could not be run here because npm registry access timed out. Run the commands below locally before deployment.

## First-run commands

From `backend/`:

```bash
npm install
npx prisma validate
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Configure `DATABASE_URL` in `backend/.env` before running Prisma commands. The MySQL database should be empty; no MongoDB data migration is included by design.
