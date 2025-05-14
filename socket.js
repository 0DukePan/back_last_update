import { Table } from "./models/table.model.js"
import TableSession from "./models/table-session.model.js"
import { User } from "./models/user.model.js"
import { Order } from "./models/order.model.js"
import MenuItem from "./models/menuItem.model.js"
import Bill from "./models/bill.model.js"
import { getValue, setValue, deleteCache } from './services/redis.service.js'
import logger from './middlewares/logger.middleware.js'
import jwt from "jsonwebtoken"

// Redis keys
const KITCHEN_SOCKET_KEY = 'kitchen:socket_id'
const KITCHEN_ORDERS_CACHE = 'kitchen:active_orders'

// Socket.IO Middleware for JWT Authentication
const socketAuthMiddleware = async (socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

  if (socket.handshake.query.clientType === 'kiosk_app') {
    logger.info(`Kiosk app connected (unauthenticated for user context): ${socket.id} - Type: ${socket.handshake.query.clientType}`);
    // Kiosk app registers itself via specific event ('register_table')
    // It doesn't need user authentication at the socket connection level itself.
    return next();
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      const user = await User.findById(decoded.userId || decoded.id).select("-password -refreshToken"); // Exclude sensitive fields

      if (!user) {
        logger.warn(`Socket Auth: User not found for token. Socket ID: ${socket.id}`);
        return next(new Error('Authentication error: User not found'));
      }
      socket.user = user; // Attach user object to the socket instance
      logger.info(`Socket Authenticated: ${socket.id}, UserID: ${user._id}`);
      next();
    } catch (err) {
      logger.warn(`Socket Auth: Invalid token. Socket ID: ${socket.id}, Error: ${err.message}`);
      next(new Error('Authentication error: Token invalid'));
    }
  } else {
    logger.warn(`Socket Auth: No token provided. Socket ID: ${socket.id}`);
    next(new Error('Authentication error: Token missing')); // For User App, token is mandatory
  }
};

export const setupSocketIO = (io) => {
  // Store connected table devices
  const connectedTables = new Map()
  // Store connected kitchen devices
  const connectedKitchens = new Map()

  // Apply authentication middleware
  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    logger.info(`---> SERVER: New socket connection attempt received! ID: ${socket.id}`);
    
    if (socket.user) {
      logger.info(`User App connected: UserID ${socket.user._id}, SocketID ${socket.id}`);
      socket.join(`user_${socket.user._id}`); // Join user-specific room
    } else if (socket.handshake.query.clientType === 'kiosk_app') {
      logger.info(`Kiosk App connected: SocketID ${socket.id}`);
      // Kiosk-specific logic follows in 'register_table'
    } else {
      logger.warn(`Unidentified client connected: ${socket.id}. Waiting for registration or identification.`);
    }

    // Table app registers itself with its table ID
    socket.on("register_table", async (data) => {
      try {
        const { tableId } = data

        if (!tableId) {
          socket.emit("error", { message: "Table ID is required" })
          return
        }

        // Validate table exists
        const table = await Table.findOne({ tableId: tableId })
        if (!table) {
          socket.emit("error", { message: "Table not found" })
          return
        }

        // Join a room specific to this table
        socket.join(`table_${tableId}`)

        // Store socket ID with table ID for direct messaging
        connectedTables.set(tableId, socket.id)

        logger.info(`Table ${tableId} registered with socket ID: ${socket.id}`)

        socket.emit("table_registered", {
          success: true,
          message: `Table ${tableId} registered successfully`,
          tableData: {
            id: table._id,
            tableId: table.tableId,
            status: table.status,
            isActive: table.isActive,
          },
        })
      } catch (error) {
        logger.error("Error registering table:", error)
        socket.emit("error", { message: "Failed to register table" })
      }
    })

    // Kitchen app registers itself
    socket.on("register_kitchen", async () => {
      try {
        // Store kitchen socket ID in Redis
        const success = await setValue(KITCHEN_SOCKET_KEY, socket.id)
        if (success) {
          logger.info(`Kitchen app registered with socket ID: ${socket.id} (Stored in Redis)`)
          // Acknowledge registration
          socket.emit("kitchen_registered", { success: true })
          // Optionally, keep joining the room if other logic depends on it
          socket.join("kitchen")
        } else {
          logger.error(`Failed to store kitchen socket ID in Redis for: ${socket.id}`)
          socket.emit("error", { message: "Failed to register kitchen due to Redis error" })
        }
      } catch (error) {
        logger.error("Error registering kitchen:", error)
        socket.emit("error", { message: "Failed to register kitchen" })
      }
    })

    // Handle tablet device registration (example - adapt as needed)
    socket.on("register_device_with_table", async (data) => {
      try {
        const { deviceId } = data
        if (!deviceId) {
          return socket.emit("error", { message: "Device ID is required" })
        }
        
        // Store tablet socket ID in Redis with device ID (or tableId if preferred)
        const key = `device:${deviceId}:socket_id`
        const success = await setValue(key, socket.id)
        if (success) {
          logger.info(`Device ${deviceId} registered with socket ID: ${socket.id} (Stored in Redis)`)
          socket.emit("device_registered", { success: true, deviceId })
        } else {
          logger.error(`Failed to store device socket ID in Redis for: ${deviceId}`)
          socket.emit("error", { message: "Failed to register device due to Redis error" })
        }
      } catch (error) {
        logger.error("Error registering device:", error)
        socket.emit("error", { message: "Failed to register device" })
      }
    })

    // Enhanced initiate_session handler for authenticated User App
    socket.on("initiate_session", async (data) => {
      // This event is expected from an AUTHENTICATED User App socket
      if (!socket.user) {
        logger.warn(`Initiate session attempt from unauthenticated socket: ${socket.id}`);
        return socket.emit("error", { message: "Authentication required to start a session." });
      }

      try {
        const { tableDeviceId, userId } = data; // tableDeviceId is the Kiosk's deviceId from QR

        if (!tableDeviceId || !userId) {
          return socket.emit("error", { message: "Table Device ID and User ID are required" });
        }

        if (socket.user._id.toString() !== userId) {
          logger.warn(`User ID mismatch: Socket user ${socket.user._id} vs data userId ${userId}`);
          return socket.emit("error", { message: "User ID mismatch." });
        }

        // 1. Find the Kiosk's Table document using its deviceId
        // The Kiosk app should have registered its deviceId as table.tableId
        const table = await Table.findOne({ tableId: tableDeviceId });
        if (!table) {
          return socket.emit("error", { message: `Table device ${tableDeviceId} not found or not registered.` });
        }
        if (!table.isActive) {
          return socket.emit("error", { message: `Table device ${tableDeviceId} is not active.` });
        }
        // Allow joining if table is 'available' or already 'occupied' (if joining existing session)
        if (table.status !== "available" && table.status !== "occupied") {
          return socket.emit("error", { message: `Table ${tableDeviceId} is not available for a new session.` });
        }

        const user = socket.user; // Already fetched by middleware

        // Optional: Check if user already has an active session elsewhere (if 1 session per user rule)
        const existingUserSession = await TableSession.findOne({ clientId: userId, status: "active" });
        if (existingUserSession && existingUserSession.tableId.toString() !== table._id.toString()) {
          return socket.emit("error", {
            message: "You already have an active session at another table.",
            // sessionId: existingUserSession._id, // Optional: provide info
          });
        }

        // 2. Create or retrieve TableSession
        let session;
        if (table.currentSession && table.status === "occupied") {
          session = await TableSession.findById(table.currentSession).populate('orders');
          if (!session || session.status === 'closed') {
            // Create new session if existing one is invalid
            table.currentSession = null; // Clear stale session
          } else {
            // Add user to existing session if not already client (more complex logic for multiple users per session)
            // For now, let's assume one primary clientId for the session.
            logger.info(`User ${userId} joining existing session ${session._id} at table ${table.tableId}`);
          }
        }
        
        if (!table.currentSession) {
          session = new TableSession({
            tableId: table._id, // MongoDB ObjectId of the Table
            clientId: userId,
            startTime: new Date(),
            status: "active",
            orders: [] // Initialize with empty orders
          });
          await session.save();
          table.status = "occupied";
          table.currentSession = session._id;
          await table.save();
          logger.info(`New session ${session._id} started for table ${table.tableId} by user ${userId}`);
        }

        // 3. Join User App's socket to the table's room
        socket.join(`table_${table.tableId}`); // table.tableId is Kiosk's device ID
        logger.info(`User App socket ${socket.id} (User ${userId}) joined room table_${table.tableId}`);

        // 4. Emit "session_started" to Kiosk App in its room
        io.to(`table_${table.tableId}`).emit("session_started", {
          sessionId: session._id.toString(),
          tableId: table.tableId, // Kiosk's device ID (the one it registered with)
          dbTableId: table._id.toString(),
          clientId: session.clientId.toString(),
          customerName: user.fullName || "Customer",
          startTime: session.startTime,
          status: session.status,
          // Include current items if any (from Kiosk if it started adding)
          items: session.orders.reduce((acc, order) => acc.concat(order.items.map(item => ({
            menuItemId: item.menuItem.toString(),
            name: item.name,
            price: item.price,
            quantity: item.quantity,
          }))), [])
        });
        logger.info(`Emitted 'session_started' to room table_${table.tableId}`);

        // 5. Emit "session_created" (or a more descriptive "session_joined") back to the initiating User App
        socket.emit("session_created", {
          sessionId: session._id.toString(),
          tableId: table.tableId, // Kiosk's device ID
          dbTableId: table._id.toString(),
          startTime: session.startTime,
          status: session.status,
          // Send current cart/order items for this session
          items: session.orders.reduce((acc, order) => acc.concat(order.items.map(item => ({
            menuItemId: item.menuItem.toString(),
            name: item.name,
            price: item.price,
            quantity: item.quantity,
          }))), []),
          currentTotal: session.orders.reduce((sum, order) => sum + order.total, 0)
        });
        logger.info(`Emitted 'session_created' back to User App socket ${socket.id}`);

      } catch (error) {
        logger.error("Error initiating session via socket:", error);
        socket.emit("error", { message: "Failed to initiate session: " + error.message });
      }
    });

    // Handle updates to table session items (cart updates)
    socket.on("update_table_session_item", async (data) => {
      try {
        const { sessionId, tableId, menuItemId, quantity, action } = data;
        
        if (!sessionId || !tableId || !menuItemId) {
          return socket.emit("error", { message: "Session ID, Table ID, and Menu Item ID are required" });
        }
        
        // Validate session exists and is active
        const session = await TableSession.findById(sessionId);
        if (!session) {
          return socket.emit("error", { message: "Session not found" });
        }
        
        if (session.status !== "active") {
          return socket.emit("error", { message: "Session is not active" });
        }
        
        // Find or create cart order for this session
        let cartOrder = await Order.findOne({ 
          sessionId: sessionId,
          status: "cart_active" // Special status for items in cart
        });
        
        if (!cartOrder) {
          // Create a new cart order
          cartOrder = new Order({
            sessionId: sessionId,
            TableId: session.tableId, // MongoDB ID of the table
            items: [],
            orderType: "Dine In",
            status: "cart_active",
            subtotal: 0,
            total: 0
          });
        }
        
        // Get menu item details
        const menuItem = await MenuItem.findById(menuItemId);
        if (!menuItem) {
          return socket.emit("error", { message: "Menu item not found" });
        }
        
        // Handle the action (add, remove, update)
        let itemIndex = cartOrder.items.findIndex(item => 
          item.menuItem.toString() === menuItemId
        );
        
        if (action === "add" || action === "update") {
          if (itemIndex >= 0) {
            // Update existing item
            cartOrder.items[itemIndex].quantity = quantity;
            cartOrder.items[itemIndex].total = menuItem.price * quantity;
          } else {
            // Add new item
            cartOrder.items.push({
              menuItem: menuItemId,
              name: menuItem.name,
              price: menuItem.price,
              quantity: quantity,
              total: menuItem.price * quantity,
              specialInstructions: data.specialInstructions || ""
            });
          }
        } else if (action === "remove") {
          if (itemIndex >= 0) {
            // Remove item
            cartOrder.items.splice(itemIndex, 1);
          }
        }
        
        // Recalculate totals
        cartOrder.subtotal = cartOrder.items.reduce((sum, item) => sum + item.total, 0);
        cartOrder.total = cartOrder.subtotal; // Add tax, delivery fee, etc. if needed
        
        // Save the updated cart
        await cartOrder.save();
        
        // If this is a new cart order, add it to the session
        if (!session.orders.includes(cartOrder._id)) {
          session.orders.push(cartOrder._id);
          await session.save();
        }
        
        // Broadcast cart update to all clients in the table room
        io.to(`table_${tableId}`).emit("table_session_cart_updated", {
          sessionId: session._id.toString(),
          items: cartOrder.items.map(item => ({
            menuItemId: item.menuItem.toString(),
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            total: item.total,
            specialInstructions: item.specialInstructions
          })),
          subtotal: cartOrder.subtotal,
          total: cartOrder.total
        });
        
        logger.info(`Cart updated for session ${sessionId}, table ${tableId}, item ${menuItemId}, action: ${action}`);
        
      } catch (error) {
        logger.error("Error updating table session item:", error);
        socket.emit("error", { message: "Failed to update cart item: " + error.message });
      }
    });

    // Customer app scans QR code (keeping for backward compatibility)
    socket.on("scan_qr_code", async (data) => {
      try {
        const { tableId, userId } = data

        if (!tableId || !userId) {
          socket.emit("error", { message: "Table ID and User ID are required" })
          return
        }

        // Validate table
        const table = await Table.findOne({ tableId: tableId })
        if (!table) {
          socket.emit("error", { message: "Table not found" })
          return
        }

        if (!table.isActive) {
          socket.emit("error", { message: "Table is not active" })
          return
        }

        if (table.status !== "available") {
          socket.emit("error", { message: "Table is not available" })
          return
        }

        // Validate user
        const user = await User.findById(userId)
        if (!user) {
          socket.emit("error", { message: "User not found" })
          return
        }

        // Check if there's an existing active session for this user
        const existingUserSession = await TableSession.findOne({
          clientId: userId,
          status: "active",
        })

        if (existingUserSession) {
          socket.emit("error", {
            message: "You already have an active session at another table",
            sessionId: existingUserSession._id,
            tableId: existingUserSession.tableId,
          })
          return
        }

        // Create a new session
        const session = new TableSession({
          tableId: table._id, // Use the MongoDB _id
          clientId: userId,
          startTime: new Date(),
          status: "active",
        })

        await session.save()

        // Update table status
        table.status = "occupied"
        table.currentSession = session._id
        await table.save()

        // Notify the table app to open the session
        io.to(`table_${tableId}`).emit("session_started", {
          sessionId: session._id,
          tableId: tableId,
          clientId: session.clientId,
          startTime: session.startTime,
          status: session.status,
          customerName: user.fullName || "Customer",
        })

        // Also notify the customer app
        socket.emit("session_created", {
          sessionId: session._id,
          tableId: tableId,
          startTime: session.startTime,
          status: session.status,
        })

        logger.info(`Session started for table ${tableId} by user ${userId} via QR scan`)
      } catch (error) {
        logger.error("Error processing QR code scan:", error)
        socket.emit("error", { message: "Failed to process QR code scan" })
      }
    })

    // Handle order updates to notify table app
    socket.on("order_placed", async (data) => {
      try {
        const { sessionId, orderId, tableId } = data

        if (!orderId) {
          socket.emit("error", { message: "Order ID is required" })
          return
        }

        // Get the order details
        const order = await Order.findById(orderId).populate({
          path: "items.menuItem",
          select: "name image category",
        })

        if (!order) {
          socket.emit("error", { message: "Order not found" })
          return
        }

        // Get table ID if available
        let orderTableId = null
        if (order.TableId) {
          // Find the table with this ID
          const table = await Table.findById(order.TableId)
          if (table) {
            orderTableId = table.tableId
          }
        }

        // If sessionId is provided, notify the table app
        if (sessionId && tableId) {
          io.to(`table_${tableId}`).emit("table_order_finalized", {
            sessionId,
            orderId: order._id.toString(),
            items: order.items.map((item) => ({
              menuItemId: item.menuItem.toString(),
              name: item.name,
              quantity: item.quantity,
              price: item.price,
              total: item.total,
            })),
            total: order.total,
            status: order.status,
            message: "Order has been placed for the table."
          });
          logger.info(`Emitted 'table_order_finalized' for session ${sessionId} to room table_${tableId}`);
        }

        logger.info(`Order ${orderId} notification sent to table app (kitchen notified via controller)`)
      } catch (error) {
        logger.error("Error handling order placed:", error)
        socket.emit("error", { message: "Failed to notify about order" })
      }
    })

    // Handle session end request
    socket.on("end_session", async (data) => {
      try {
        const { sessionId, tableId } = data

        if (!sessionId) {
          socket.emit("error", { message: "Session ID is required" })
          return
        }

        // Find the session
        const session = await TableSession.findById(sessionId)
        if (!session) {
          socket.emit("error", { message: "Session not found" })
          return
        }

        if (session.status === "closed") {
          socket.emit("error", { message: "Session is already closed" })
          return
        }

        // Check if bill already exists
        let bill = await Bill.findOne({ tableSessionId: sessionId })

        if (!bill) {
          // Get all orders for this session
          const orders = await Order.find({ _id: { $in: session.orders } })

          // Calculate total
          const total = orders.reduce((sum, order) => sum + order.total, 0)

          // Create bill
          bill = new Bill({
            tableSessionId: sessionId,
            total,
            paymentStatus: "pending",
          })

          await bill.save()
        }

        // Update session status
        session.status = "closed"
        session.endTime = new Date()
        await session.save()

        // Update table status
        const table = await Table.findById(session.tableId)
        if (table) {
          table.status = "cleaning"
          table.currentSession = null
          await table.save()
        }

        // Notify both table app and customer app
        const effectiveTableId = tableId || (table ? table.tableId : null);
        if(effectiveTableId) {
          io.to(`table_${effectiveTableId}`).emit("session_ended", {
            sessionId,
            bill: {
              id: bill._id,
              total: bill.total,
              paymentStatus: bill.paymentStatus,
            },
          })
        }

        // Also emit back to the caller (e.g., Kiosk app)
        socket.emit("session_ended_confirmation", {
          sessionId,
          bill: {
            id: bill._id,
            total: bill.total,
            paymentStatus: bill.paymentStatus,
          },
        })

        logger.info(`Session ${sessionId} ended and bill created`)
      } catch (error) {
        logger.error("Error ending session:", error)
        socket.emit("error", { message: "Failed to end session" })
      }
    })

    // Handle bill creation notification
    socket.on("bill_created", async (data) => {
      try {
        const { billId, sessionId, tableId } = data

        if (!billId || !sessionId) {
          socket.emit("error", { message: "Bill ID and Session ID are required" })
          return
        }

        // Notify the table app about the bill
        io.to(`table_${tableId}`).emit("bill_ready", {
          billId,
          sessionId,
        })

        logger.info(`Bill ${billId} notification sent to table ${tableId}`)
      } catch (error) {
        logger.error("Error handling bill creation:", error)
        socket.emit("error", { message: "Failed to notify about bill" })
      }
    })

    // Handle reservation events
    socket.on("make_reservation", async (data) => {
      try {
        const { userId, tableId, reservationTime } = data

        if (!userId || !tableId || !reservationTime) {
          socket.emit("error", { message: "User ID, Table ID, and reservation time are required" })
          return
        }

        // Notify admin about new reservation request
        io.emit("new_reservation_request", {
          userId,
          tableId,
          reservationTime,
        })

        logger.info(`New reservation request from user ${userId} for table ${tableId}`)
      } catch (error) {
        logger.error("Error handling reservation request:", error)
        socket.emit("error", { message: "Failed to process reservation request" })
      }
    })

    // Handle disconnection
    socket.on("disconnect", async () => {
      logger.info(`Socket disconnected: ${socket.id}`)
      
      // Check if this was the kitchen socket and remove it from Redis
      try {
        const kitchenSocketId = await getValue(KITCHEN_SOCKET_KEY)
        if (kitchenSocketId === socket.id) {
          await deleteCache(KITCHEN_SOCKET_KEY) // Use deleteCache which calls .del()
          logger.info(`Removed disconnected kitchen socket ID from Redis: ${socket.id}`)
        }
        // TODO: Add logic here to remove disconnected device sockets if needed
      } catch (error) {
        logger.error(`Error cleaning up disconnected socket ${socket.id} from Redis:`, error)
      }

      // Remove from connected tables if this was a table app
      for (const [tableId, socketId] of connectedTables.entries()) {
        if (socketId === socket.id) {
          connectedTables.delete(tableId)
          logger.info(`Table with ID ${tableId} disconnected`)
          break
        }
      }

      // Remove from connected kitchens if this was a kitchen app
      for (const [kitchenId, socketId] of connectedKitchens.entries()) {
        if (socketId === socket.id) {
          connectedKitchens.delete(kitchenId)
          logger.info(`Kitchen with ID ${kitchenId} disconnected`)
          break
        }
      }
    })
  })
}

/**
 * Notify kitchen about a new order
 * @param {object} io - Socket.IO server instance
 * @param {object} order - The new order object (mongoose document expected)
 */
export const notifyKitchenAboutNewOrder = async (io, order) => {
  try {
    // Get kitchen socket ID from Redis
    const kitchenSocketId = await getValue(KITCHEN_SOCKET_KEY)
    
    if (!kitchenSocketId) {
      logger.warn("No kitchen app registered, cannot notify about new order")
      return false
    }
    
    // Format order for kitchen display (ensure necessary fields are present)
    const formattedOrder = {
      id: order._id.toString(), // Use _id
      orderNumber: order._id.toString().slice(-6).toUpperCase(),
      items: order.items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        specialInstructions: item.specialInstructions || "",
        // Assuming menuItem might not be populated here, handle gracefully
        category: item.menuItem?.category || null, 
      })),
      orderType: order.orderType,
      // Ensure TableId is populated or handled if not
      tableId: order.TableId?.toString() || order.deviceId || null, // Use deviceId if TableId link isn't there
      status: order.status,
      createdAt: order.createdAt,
      // elapsedTime calculation might be better done on the client 
    }
    
    // Emit event directly to kitchen socket
    io.to(kitchenSocketId).emit("new_kitchen_order", formattedOrder)
    
    // Invalidate kitchen orders cache *after* successful emission
    await deleteCache(KITCHEN_ORDERS_CACHE)
    
    logger.info(`Notified kitchen (${kitchenSocketId}) about new order: ${order._id}`)
    return true
  } catch (error) {
    logger.error(`Error notifying kitchen about new order ${order?._id}:`, error)
    return false
  }
}

/**
 * Notify kitchen about order status update
 * @param {object} io - Socket.IO server instance
 * @param {object} order - The updated order (mongoose document expected)
 * @param {string} previousStatus - Previous order status
 */
export const notifyKitchenAboutOrderUpdate = async (io, order, previousStatus) => {
  try {
    // Get kitchen socket ID from Redis
    const kitchenSocketId = await getValue(KITCHEN_SOCKET_KEY)
    
    if (!kitchenSocketId) {
      logger.warn("No kitchen app registered, cannot notify about order update")
      return false
    }
    
    // Format order update for kitchen display
    const orderUpdate = {
      id: order._id.toString(),
      orderNumber: order._id.toString().slice(-6).toUpperCase(),
      status: order.status,
      previousStatus, // Send previous status for client logic
      updatedAt: order.updatedAt || new Date(), // Use order updatedAt if available
    }
    
    // Emit event directly to kitchen socket
    io.to(kitchenSocketId).emit("order_status_updated", orderUpdate)

    // Invalidate kitchen orders cache *after* successful emission
    await deleteCache(KITCHEN_ORDERS_CACHE)
    
    logger.info(`Notified kitchen (${kitchenSocketId}) about order update: ${order._id} (${previousStatus} -> ${order.status})`)
    return true
  } catch (error) {
    logger.error(`Error notifying kitchen about order update ${order?._id}:`, error)
    return false
  }
}

/**
 * Function to add to order.controller.js after order.save() in createOrder
 * Notifies all clients in the table room about the finalized order
 * @param {object} req - Express request object with io attached
 * @param {object} order - The newly created order
 */
export const notifyTableAboutFinalizedOrder = async (req, order) => {
  try {
    if (!req.io || order.orderType !== "Dine In" || !order.TableId || !order.sessionId) {
      return false;
    }
    
    const tableDoc = await Table.findById(order.TableId);
    if (!tableDoc) {
      logger.warn(`Table not found for order ${order._id} with TableId ${order.TableId}`);
      return false;
    }
    
    req.io.to(`table_${tableDoc.tableId}`).emit('table_order_finalized', {
      sessionId: order.sessionId.toString(),
      orderId: order._id.toString(),
      items: order.items.map(i => ({
        menuItemId: i.menuItem.toString(), 
        name: i.name, 
        quantity: i.quantity, 
        total: i.total
      })),
      total: order.total,
      message: "Order has been placed for the table."
    });
    
    logger.info(`Emitted 'table_order_finalized' for session ${order.sessionId} to room table_${tableDoc.tableId}`);
    return true;
  } catch (error) {
    logger.error(`Error notifying table about finalized order ${order?._id}:`, error);
    return false;
  }
}