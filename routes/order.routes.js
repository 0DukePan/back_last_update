import express from "express"
import {
  createOrder,
  getOrderDetails,
  updateOrderStatus,
  getOrdersByUser,
  getOrdersBySession,
  getKitchenOrders,
  updatePaymentStatus,
  getCompletedKitchenOrders,
  submitOrderRatings
} from '../controllers/order.controller.js';
import { protect , isAdmin } from "../middlewares/auth.middleware.js"

const router = express.Router()
// Define specific routes BEFORE parameterized routes
router.get("/kitchen/completed",  getCompletedKitchenOrders);
router.get("/kitchenn/active", protect, isAdmin, getKitchenOrders);

// General & Parameterized Routes
router.post("/", createOrder); // Removed protect for kiosk app
router.get("/:orderId", protect, getOrderDetails); 
router.put("/:orderId/status",  updateOrderStatus); 
router.put("/:orderId/payment", protect, updatePaymentStatus);
router.get("/user/:userId", protect, getOrdersByUser); // Matches /user/some-user-id
router.get("/session/:sessionId", getOrdersBySession); // Matches /session/some-session-id // Removed protect for kiosk app?
router.post("/:orderId/rate-items", protect,submitOrderRatings)

// --- Old position of completed route (removed) ---
// router.get("/completed", /* verifyToken, verifyAdmin, */ getCompletedKitchenOrders);

export default router; 