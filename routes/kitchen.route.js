import express from "express"
import { getKitchenOrders, getCompletedKitchenOrders, updateOrderStatus } from "../controllers/order.controller.js"
import { protect } from "../middlewares/auth.middleware.js"

const router = express.Router()

// Get all active kitchen orders
router.get("/orders", getKitchenOrders)

// Get recently completed/cancelled orders for the kitchen view
router.get("/completed", getCompletedKitchenOrders)

// Mark order as preparing
router.put("/orders/:orderId/preparing", protect, (req, res, next) => {
  req.body.status = "preparing"
  updateOrderStatus(req, res, next)
})

// Mark order as ready
router.put("/orders/:orderId/ready", protect, (req, res, next) => {
  req.body.status = "ready_for_pickup"
  updateOrderStatus(req, res, next)
})

// Mark order as delivered/completed
router.put("/orders/:orderId/completed", protect, (req, res, next) => {
  req.body.status = "completed"
  updateOrderStatus(req, res, next)
})

export default router
