// import dotenv from 'dotenv';
// // Initialize environment variables FIRST
// dotenv.config(); 

// import express from 'express';
// import cors from 'cors';
// import http from 'http';
// import mongoose from 'mongoose';
// // Import Server from socket.io
// import { Server } from 'socket.io'; 
// // Revert to importing the original setup function from socket.js
// import { setupSocketIO } from './socket.js'; 
// import logger from './middlewares/logger.middleware.js';
// // Remove Redis service import
// // import './services/redis.service.js'; 

// // --- Import Routes ---
// // Ensure all route imports use .js extension if using ES Modules
// import menuItemRoutes from './routes/menu-item.route.js';
// import orderRoutes from './routes/order.route.js';
// import kitchenRoutes from './routes/kitchen.route.js';
// import tableRoutes from './routes/table.route.js'; // Assuming you have this
// import authRoutes from './routes/auth.route.js';   // Assuming you have this
// // Add other route imports...

// // // Initialize environment variables - MOVED TO TOP
// // dotenv.config();

// // Create Express app
// const app = express();

// // Middleware
// app.use(cors({ // Configure CORS properly for production
//     // origin: 'YOUR_FRONTEND_URL' 
//     origin: '*', // Example: Allow all for now
//     methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
//     allowedHeaders: ['Content-Type', 'Authorization'],
// }));
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// // --- Create HTTP Server ---
// const server = http.createServer(app);

// // --- Initialize Socket.IO using the function from socket.js ---
// const io = setupSocketIO(server);
// // Remove app.set('io', io) for now, as the original might not have needed it
// // app.set('io', io);

// // --- API Routes ---
// // Prefix routes with /api
// app.use('/api/auth', authRoutes);
// app.use('/api/menu-items', menuItemRoutes);
// app.use('/api/orders', orderRoutes);
// app.use('/api/kitchen', kitchenRoutes);
// app.use('/api/tables', tableRoutes);
// // Add other app.use(...) for your routes

// // Simple root route for health check
// app.get('/', (req, res) => {
//   logger.info('--- Root route / was hit! ---'); 
//   res.send('Restaurant Backend API is running!');
// });

// // --- Global Error Handling Middleware ---
// // This should be defined AFTER all other app.use() and routes
// app.use((err, req, res, next) => {
//   logger.error(err.stack);
//   const statusCode = err.statusCode || 500;
//   res.status(statusCode).json({
//     success: false,
//     message: err.message || 'An unexpected error occurred',
//     // Provide error details only in development
//     error: process.env.NODE_ENV === 'development' ? err.stack : undefined
//   });
// });

// // --- Connect to MongoDB and Start Server ---
// const MONGODB_URI = process.env.MONGODB_URI;
// if (!MONGODB_URI) {
//     logger.error('MongoDB connection string (MONGODB_URI) is missing in .env file.');
//     process.exit(1);
// }

// mongoose.connect(MONGODB_URI)
//   .then(() => {
//     logger.info('Connected to MongoDB successfully.');
    
//     // Start the HTTP server (which includes Socket.IO)
//     const PORT = process.env.PORT || 5000;
//     server.listen(PORT, () => {
//       // Reverted log message
//       logger.info(`Server running on port ${PORT}. Socket.IO setup via socket.js.`);
//     });
//   })
//   .catch((err) => {
//     logger.error('MongoDB connection error:', err);
//     process.exit(1); // Exit if DB connection fails
//   });

// export default app; // Export app for potential testing 