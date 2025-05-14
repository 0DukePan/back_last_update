import express from "express"
import {
  getUserProfile,
  updateUserProfile,
  addAddress,
  updateAddress,
  deleteAddress,
  getAddresses,
  addToFavorites,
  removeFromFavorites,
  getFavorites,
  logoutUser,
} from "../controllers/user.controller.js"
import { protect } from "../middlewares/auth.middleware.js"

const router = express.Router()

// Profile routes
router.get("/profile", protect, getUserProfile)
router.put("/profile", protect, updateUserProfile)

// Address routes
router.post("/addresses", protect, addAddress)
router.put("/addresses/:id", protect, updateAddress)
router.delete("/addresses/:id", protect, deleteAddress)
router.get("/addresses", protect, getAddresses)

// Favorites routes
router.post("/favorites/:id", protect, addToFavorites)
router.delete("/favorites/:id", protect, removeFromFavorites)
router.get("/favorites", protect, getFavorites)

// Logout route
router.post("/logout", protect, logoutUser)

export default router
