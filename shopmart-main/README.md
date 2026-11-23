# SHOPMART

SHOPMART is a React storefront backed by an Express API, **MySQL through Prisma ORM**, JWT authentication, Google OAuth, file uploads, email notifications, and Razorpay checkout.

## Technology

- Frontend: React + Vite
- Backend: Node.js + Express
- Database: MySQL
- ORM: Prisma
- Authentication: JWT + Google OAuth
- Payment: Razorpay

## Requirements

- Node.js 20.19+ (Node.js 22 LTS recommended)
- MySQL 8.0+
- npm

## 1. Create the MySQL database

Create an empty database and application user in MySQL. Example:

```sql
CREATE DATABASE shopmart CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'shopmart_user'@'localhost' IDENTIFIED BY 'replace_with_a_strong_password';
GRANT ALL PRIVILEGES ON shopmart.* TO 'shopmart_user'@'localhost';
FLUSH PRIVILEGES;
```

If MySQL is hosted remotely, use the host, port, username, and password provided by that provider instead of `127.0.0.1`.

## 2. Configure the backend

```bash
cd backend
npm install
```

Copy `backend/.env.example` to `backend/.env`, then configure at least:

```env
PORT=5000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173
DATABASE_URL="mysql://shopmart_user:your_password@127.0.0.1:3306/shopmart"
JWT_SECRET=use-a-long-random-secret
```

Set valid Google OAuth, Razorpay, and SMTP credentials when those features are required. Never commit `.env` or expose Razorpay secret keys in the frontend.

## 3. Generate Prisma Client and create tables

From the `backend` directory:

```bash
npx prisma generate
npx prisma migrate dev --name init
```

The migration command creates the initial MySQL tables from `prisma/schema.prisma`. The database is intentionally empty; register users and create products/categories from the application after starting it.

For production, commit the generated `backend/prisma/migrations` directory and run:

```bash
npx prisma migrate deploy
```

Useful commands:

```bash
npm run db:generate
npm run db:migrate
npm run db:deploy
npm run db:studio
```

## 4. Configure and run the frontend

In a second terminal:

```bash
cd frontend
npm install
```

Copy `frontend/.env.example` to `frontend/.env`. Set the API URL and the same Google OAuth web client ID used by the backend:

```env
VITE_API_URL=http://localhost:5000/api
VITE_GOOGLE_CLIENT_ID=your-google-oauth-web-client-id.apps.googleusercontent.com
```

## 5. Start the application

Terminal 1, backend:

```bash
cd backend
npm run dev
```

Terminal 2, frontend:

```bash
cd frontend
npm run dev
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`). Backend health check: `http://localhost:5000/api/health`.

## 6. Create the first administrator

Register an account through the storefront, then promote it using MySQL Workbench or the MySQL CLI:

```sql
UPDATE `User`
SET role = 'admin'
WHERE email = 'your-admin-email@example.com';
```

Prisma uses the model table name `User` by default. If your database was created with a custom table mapping, inspect it with `SHOW TABLES;` and adjust the query accordingly.

## Deployment notes

- Deploy the React/Vite frontend as a static site. Set `VITE_API_URL` to the public backend API URL.
- Deploy the Express backend to a Node.js host or VPS. Set `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`, and `CORS_ORIGINS` in the hosting environment.
- `CORS_ORIGINS` is a comma-separated list of exact frontend origins, for example `https://shopmart.example.com,https://www.shopmart.example.com`.
- Configure `UPLOAD_DIR` to a persistent writable directory. The backend stores product, banner, and profile images on disk; ephemeral server filesystems will lose uploads on redeploy.
- Configure the Google OAuth authorized JavaScript origins and redirect/credential settings for the production domain as required by the Google client configuration.
- Keep Razorpay secret credentials only in the backend environment.
- Use HTTPS for both frontend and API in production.

## Database implementation note

The migration replaces MongoDB/Mongoose persistence with a Prisma Client connected to MySQL. To preserve the existing controller behavior and API response shapes during this first migration, the backend includes a small compatibility repository (`backend/lib/legacyModel.js`) that translates the project's existing model operations to Prisma. It currently evaluates several legacy-style filters in application memory, so it is suitable as a migration bridge and for a small school/demo deployment, but it should be refactored into direct Prisma queries before using SHOPMART at production scale with large datasets.
