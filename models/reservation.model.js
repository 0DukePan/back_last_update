import mongoose from "mongoose";

const ReservationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Table",
      required: true,
    },
    reservationTime: { type: Date, required: true },
    status: {
      type: String,
      enum: ["confirmed", "cancelled", "completed", "no-show"],
      default: "confirmed",
    },
    guests: { type: Number, required: true },
    paymentMethod: { type: String, enum: ["card", "cash", "wallet"], default: "cash" },
    specialRequests: { type: String },
    preSelectedMenu: [
      {
        _id: false,
        menuItemId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "MenuItem",
          required: true,
        },
        quantity: { type: Number, default: 1 },
        specialInstructions: { type: String },
      },
    ],

  },
  { timestamps: true }
);

ReservationSchema.index({ tableId: 1, reservationTime: 1 });
ReservationSchema.index({ userId: 1, reservationTime: -1 });



export const Reservation = mongoose.model("Reservation", ReservationSchema);
