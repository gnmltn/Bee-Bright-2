Here is your **updated README** with the added **System Requirements & Troubleshooting** section included.
You can copy and paste everything below directly into your README file.

---

# 🐝 Bee Bright Tutorial Center Management System

A modern web-based management system designed to upgrade Bee Bright Tutorial Center from a manual, paper-based process to a fully digital platform. The system supports enrollment, scheduling, billing, online payments, and integrates AI and Blockchain technologies for enhanced automation and security.

---

## 📌 Project Overview

The **Bee Bright Tutorial Center Management System** transforms traditional manual operations into a secure and efficient online platform.

### 🎯 Problem It Solves

* Eliminates manual paperwork
* Reduces human errors in scheduling and billing
* Streamlines enrollment and payment processes
* Improves record management and accessibility

### 👥 Target Users

* Students
* Tutors
* Administrators

---

## 🚀 Features

* 🔐 User Authentication & Authorization
* 👨‍🎓 Student Dashboard
* 👩‍🏫 Tutor Dashboard
* 🛠 Admin Dashboard
* 📋 Enrollment Management
* 📅 Scheduling System
* 💳 Online Payment & Billing System
* 📂 File Uploads
* 🔄 CRUD Operations
* 🔗 API Integration
* 📜 Logging System
* 🤖 AI Integration
* ⛓ Blockchain Integration for enhanced data security

---

## 🛠 Tech Stack

### Frontend

* TypeScript

### Backend

* Node.js

### Database

* MongoDB

---

## 📂 Project Structure

```
BEEBRIGHT-UI-SHOWCASE
│
├── .vscode
├── backend
├── frontend
└── node_modules
```

---

## ⚙️ System Requirements

Before running the project, make sure you have the following installed:

* **Node.js v22.22.0** ✅ (Required Version)
* npm (comes with Node.js)
* MongoDB (Local or MongoDB Atlas)
* Git

> ⚠️ This project was developed and tested using **Node.js v22.22.0**.
> Using a different Node.js version may cause dependency or runtime issues.

Check your Node version:

```bash
node -v
```

---

## ⚙️ Installation Guide

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/your-username/your-repository-name.git
cd BEEBRIGHT-UI-SHOWCASE
```

---

### 2️⃣ Install Dependencies

Install backend dependencies:

```bash
cd backend
npm install
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

Make sure MongoDB is installed and running on your system.

---

### 3️⃣ Environment Variables

Create a `.env` file inside the `backend` folder and add:

```
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_very_long_secure_random_secret_key_here
PORT=5000
```

> ⚠️ `JWT_SECRET` must be at least **32 characters long**.

---

### 4️⃣ Run the Project Locally

Start the backend server:

```bash
cd backend
npm run dev
```

Start the frontend server:

```bash
cd frontend
npm run dev
```

The frontend will provide a localhost link in the terminal (usually something like `http://localhost:5173` or `http://localhost:3000`).

---

# 🚨 Troubleshooting Guide

## 1️⃣ npm install Errors

If `npm install` fails:

### Clear npm cache

```bash
npm cache clean --force
```

### Delete node_modules and reinstall

**Mac/Linux**

```bash
rm -rf node_modules package-lock.json
npm install
```

**Windows (PowerShell)**

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
npm install
```

---

## 2️⃣ MongoDB Connection Error

If you see:

```
MongooseServerSelectionError: Could not connect to any servers
```

✔ Ensure MongoDB is running
✔ Verify your `.env` `MONGODB_URI` is correct
✔ If using MongoDB Atlas:

* Whitelist your IP address
* Check database credentials
* Ensure the cluster is active

---

## 3️⃣ JWT Secret Error

If you see:

```
Missing or invalid required env: JWT_SECRET (min 32 characters)
```

Make sure your `.env` includes:

```
JWT_SECRET=your_very_secure_32_character_minimum_secret_key
```

---

## 4️⃣ Port Already in Use

If you see:

```
Error: listen EADDRINUSE
```

**Windows**

```bash
netstat -ano | findstr :5000
taskkill /PID <PID> /F
```

**Mac/Linux**

```bash
lsof -i :5000
kill -9 <PID>
```

Or change the `PORT` in your `.env` file.

---

## 5️⃣ Frontend Cannot Connect to Backend

✔ Make sure backend is running first
✔ Check API base URL configuration
✔ Ensure CORS is properly configured

---

## 🔄 Clean Rebuild Procedure

If the project behaves unexpectedly:

1. Stop backend and frontend servers
2. Delete `node_modules` in both folders
3. Run:

```bash
npm install
```

4. Restart backend:

```bash
npm run dev
```

5. Restart frontend:

```bash
npm run dev
```

---

## 🖥 Application Type

This is a **Web-Based Application**.

---

## 👥 Contributors

* **Aquino, Alexis John**
  *UI/UX Designer, Frontend Developer*
* **Cabuang, Lanch**
  *Security Analyst*
* **Cruz, Oyo Boy**
  *Project Manager, Quality Assurance*
* **Latina, Gaea Nizza**
  *Backend Developer*
* **Papauran, Saymon Paul John**
  *Document Specialist*
* **Soriano, Jay Kenneth**
  *Database Administrator*

---

## 🎓 Academic Project Notice

This project was developed as a **school academic requirement**.
It is intended for educational purposes only.

---

## 🔮 Future Improvements

* Deployment to cloud hosting
* Enhanced AI-based analytics
* Expanded blockchain-based verification
* Mobile responsiveness improvements
* Advanced reporting and data visualization
