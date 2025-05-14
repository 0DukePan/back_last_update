import express from "express";
import {
    getAvailability,
    createReservation,
    getReservations
} from "../controllers/reservation.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Public routes
router.get("/availability", getAvailability)
router.post("/", protect, createReservation)
router.get("/",protect ,getReservations)

export default router