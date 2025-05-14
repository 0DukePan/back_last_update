import { Table } from "../models/table.model.js"
import { Order } from "../models/order.model.js"
import MenuItem from "../models/menuItem.model.js"
import TableSession from "../models/table-session.model.js"
import { User } from "../models/user.model.js"
import redisService, { getCache, setCache, deleteCache } from '../services/redis.service.js';
import { notifyKitchenAboutNewOrder, notifyKitchenAboutOrderUpdate } from '../socket.js'
import logger from '../middlewares/logger.middleware.js'

// Define cache keys
const KITCHEN_ORDERS_CACHE = 'kitchen:active_orders'
const COMPLETED_ORDERS_CACHE = 'kitchen:completed_orders'


// Add cache key constants
const ORDER_DETAILS_CACHE_PREFIX = 'order:details:';
const USER_ORDERS_CACHE_PREFIX = 'order:user:';
const SESSION_ORDERS_CACHE_PREFIX = 'order:session:';
const RATINGS_CACHE_PREFIX = 'order:ratings:';

// Cache expiration times (in seconds)
const ORDER_DETAILS_CACHE_EXPIRATION = 3600; // 1 hour
const USER_ORDERS_CACHE_EXPIRATION = 1800; // 30 minutes
const SESSION_ORDERS_CACHE_EXPIRATION = 1800;


// Create a new order
export const createOrder = async (req, res, next) => {
  try {
    const { userId, items, deliveryAddress, deliveryInstructions, paymentMethod, sessionId, tableId, orderType, deviceId } =
      req.body

    if (!items || !items.length || !orderType) {
      return res.status(400).json({ message: "Items and order type are required" })
    }
    if (orderType === 'Dine In' && !tableId && !deviceId) {
        return res.status(400).json({ message: "Table ID or Device ID is required for Dine In orders" })
    }
     // Validate user if userId is provided
     if (userId) {
      const user = await User.findById(userId)
      if (!user) {
        return res.status(404).json({ message: "User not found" })
      }
    }

    // Calculate order details
    let subtotal = 0
    const orderItems = []

    for (const item of items) {
      const { menuItemId, quantity, specialInstructions } = item

      if (!menuItemId || !quantity) {
        return res.status(400).json({ message: "Menu item ID and quantity are required for each item" })
      }

      const menuItem = await MenuItem.findById(menuItemId)
      if (!menuItem) {
        return res.status(404).json({ message: `Menu item with ID ${menuItemId} not found` })
      }

      if (!menuItem.isAvailable) {
        return res.status(400).json({ message: `Menu item ${menuItem.name} is not available` })
      }

      // Calculate item total
      const itemPrice = menuItem.price
      const total = itemPrice * quantity
      subtotal += total

      orderItems.push({
        menuItem: menuItemId,
        name: menuItem.name,
        price: itemPrice,
        quantity,
        total,
        specialInstructions: specialInstructions || "",
         // Add productId here to match Flutter model expectations
         productId: `prod_${menuItem.name}`,
      })
    }

    // Set delivery fee based on order type
    const deliveryFee = orderType === "Delivery" ? 2.0 : 0
    const total = subtotal + deliveryFee

    // Find table by tableId if provided
    let tableDbId = null
    if (tableId) {
      const table = await Table.findOne({ tableId: tableId })
      if (table) {
        tableDbId = table._id
      }
    }

    // Create the order
    const order = new Order({
      user: userId,
      items: orderItems,
      TableId: tableDbId,
      deviceId: deviceId,
      subtotal,
      deliveryFee,
      total,
      orderType,
      status: 'pending',
      paymentStatus: "pending",
      paymentMethod: paymentMethod || "cash",
      deliveryAddress: deliveryAddress || {
        address: orderType === "Dine In" ? "Dine-in" : "Pick up at restaurant",
        apartment: "",
        landmark: "",
        latitude: 0,
        longitude: 0,
      },
      deliveryInstructions: deliveryInstructions || "",
    })

    await order.save()

    // If session ID is provided, add order to the session
    if (sessionId) {
      const session = await TableSession.findById(sessionId)
      if (!session) {
        return res.status(404).json({ message: "Session not found" })
      }

      session.orders.push(order._id)
      await session.save()

      // Notify connected clients via Socket.IO
      if (req.io && tableId) {
        req.io.to(`table_${tableId}`).emit("new_order", {
          sessionId: session._id,
          orderId: order._id,
          items: order.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            total: item.total,
          })),
          total: order.total,
          status: order.status,
        })
      }
    }

    // --- Notify Kitchen via Socket.IO --- 
    // Ensure req.io exists (passed via middleware)
    if (req.io) {
      if (['pending', 'confirmed', 'preparing'].includes(order.status)) {
          // Fetch populated order if needed by notify function (or handle population inside)
          // Let's assume notifyKitchenAboutNewOrder can handle population or doesn't need it strictly
          // Pass req.io when calling the notification function
          await notifyKitchenAboutNewOrder(req.io, order); // Pass the original saved order 
      }
    } else {
        logger.warn('req.io not available in createOrder, cannot send socket notification.');
    }
    // ------------------------------------

    res.status(201).json({ 
      success: true, 
      message: 'Order created successfully', 
      order // Send back the created order
    });

  } catch (error) {
    logger.error('Error creating order:', error);
    // Check for Mongoose validation errors
    if (error.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: 'Validation Error', errors: error.errors });
    }
    next(error); // Pass to generic error handler
  }
};

// Get order details
export const getOrderDetails = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const cacheKey = `${ORDER_DETAILS_CACHE_PREFIX}${orderId}`;

    // Try to get from cache first
    if (redisService.isConnected && redisService.isConnected()) {
      const cachedOrder = await getCache(cacheKey);
      if (cachedOrder) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ order: cachedOrder });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    const order = await Order.findById(orderId).populate({
      path: "items.menuItem",
      select: "name image price",
    });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Store in cache if Redis is connected
    if (redisService.isConnected && redisService.isConnected()) {
      await setCache(cacheKey, order, ORDER_DETAILS_CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({ order });
  } catch (error) {
    logger.error(`Error in getOrderDetails: ${error.message}`, error);
    next(error);
  }
};

// Update order status
export const updateOrderStatus = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    // Validation
    if (!status) {
      return res.status(400).json({ success: false, message: 'New status is required' });
    }
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const previousStatus = order.status;
    if (previousStatus === status) {
      return res.status(200).json({ 
        success: true, // Indicate success even if no change
        message: 'Order status is already ' + status, 
        order 
      });
    }

    // Update status and save
    order.status = status;
    order.updatedAt = new Date();
    await order.save();

    // --- Notify Kitchen via Socket.IO --- 
    if (req.io) {
      const kitchenRelevantStatuses = ['pending', 'confirmed', 'preparing', 'ready_for_pickup', 'completed', 'cancelled'];
      const wasRelevant = kitchenRelevantStatuses.includes(previousStatus);
      const isRelevant = kitchenRelevantStatuses.includes(status);
      
      if (wasRelevant || isRelevant) {
        // Pass req.io to the notification function
        await notifyKitchenAboutOrderUpdate(req.io, order, previousStatus);
      }
    } else {
      logger.warn('req.io not available in updateOrderStatus, cannot send socket notification.');
    }
    // ------------------------------------

    // --- Cache Invalidation ---
    if (redisService.isConnected()) {
      // 1. Invalidate order details cache
      const orderCacheKey = `${ORDER_DETAILS_CACHE_PREFIX}${orderId}`;
      await deleteCache(orderCacheKey);
      logger.info(`Invalidated cache for key: ${orderCacheKey} (status updated)`);
      
      // 2. Invalidate user orders cache if user ID is available
      if (order.user) {
        const userCacheKey = `${USER_ORDERS_CACHE_PREFIX}${order.user}`;
        await deleteCache(userCacheKey);
        logger.info(`Invalidated cache for key: ${userCacheKey} (order status updated)`);
      }
      
      // 3. Invalidate session orders cache if this order is part of a session
      const session = await TableSession.findOne({ orders: orderId });
      if (session) {
        const sessionCacheKey = `${SESSION_ORDERS_CACHE_PREFIX}${session._id}`;
        await deleteCache(sessionCacheKey);
        logger.info(`Invalidated cache for key: ${sessionCacheKey} (order status updated)`);
      }
      
      // 4. Invalidate kitchen orders caches based on status
      const completedStatuses = ['ready_for_pickup', 'completed', 'cancelled'];
      const activeStatuses = ['pending', 'confirmed', 'preparing'];
      
      // If status changed between active and completed, invalidate both caches
      if (
        (activeStatuses.includes(previousStatus) && completedStatuses.includes(status)) ||
        (completedStatuses.includes(previousStatus) && activeStatuses.includes(status))
      ) {
        await deleteCache(KITCHEN_ORDERS_CACHE);
        await deleteCache(COMPLETED_ORDERS_CACHE);
        logger.info(`Invalidated kitchen order caches (status changed between active/completed)`);
      }
      // If status changed within active statuses, invalidate active cache
      else if (activeStatuses.includes(previousStatus) && activeStatuses.includes(status)) {
        await deleteCache(KITCHEN_ORDERS_CACHE);
        logger.info(`Invalidated active kitchen orders cache (active status updated)`);
      }
      // If status changed within completed statuses, invalidate completed cache
      else if (completedStatuses.includes(previousStatus) && completedStatuses.includes(status)) {
        await deleteCache(COMPLETED_ORDERS_CACHE);
        logger.info(`Invalidated completed kitchen orders cache (completed status updated)`);
      }
    }
    // --- End Cache Invalidation ---
    
    res.status(200).json({ 
      success: true, 
      message: 'Order status updated successfully', 
      order 
    });

  } catch (error) {
    logger.error(`Error updating order status for ${req.params.orderId}:`, error);
    next(error);
  }
};

// Get orders by user
export const getOrdersByUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { status } = req.query;
    
    // Create a cache key that includes the status filter if present
    const cacheKey = status 
      ? `${USER_ORDERS_CACHE_PREFIX}${userId}:status:${status}`
      : `${USER_ORDERS_CACHE_PREFIX}${userId}`;

    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedOrders = await getCache(cacheKey);
      if (cachedOrders) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ orders: cachedOrders });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    const query = { user: userId };
    if (status) {
      query.status = status;
    }

    const orders = await Order.find(query)
      .populate("restaurant", "name logo")
      .select("items subtotal total status createdAt")
      .sort({ createdAt: -1 });

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(cacheKey, orders, USER_ORDERS_CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({ orders });
  } catch (error) {
    logger.error(`Error in getOrdersByUser: ${error.message}`, error);
    next(error);
  }
};

// Get orders by session
export const getOrdersBySession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const cacheKey = `${SESSION_ORDERS_CACHE_PREFIX}${sessionId}`;

    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedSessionData = await getCache(cacheKey);
      if (cachedSessionData) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json(cachedSessionData);
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    const session = await TableSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    const orders = await Order.find({ _id: { $in: session.orders } })
      .populate({
        path: "items.menuItem",
        select: "name image isVeg",
      })
      .sort({ createdAt: -1 });

    // Calculate session total
    const sessionTotal = orders.reduce((total, order) => total + order.total, 0);

    const sessionData = {
      sessionId: session._id,
      tableId: session.tableId,
      status: session.status,
      startTime: session.startTime,
      endTime: session.endTime,
      orders,
      sessionTotal,
    };

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(cacheKey, sessionData, SESSION_ORDERS_CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json(sessionData);
  } catch (error) {
    logger.error(`Error in getOrdersBySession: ${error.message}`, error);
    next(error);
  }
};

// Get active kitchen orders (for API polling / initial load)
export const getKitchenOrders = async (req, res, next) => {
  try {
    // Try to get from cache first
    const cachedOrders = await getCache(KITCHEN_ORDERS_CACHE)
    
    if (cachedOrders) {
      logger.info('Serving active kitchen orders from cache')
      return res.status(200).json({ orders: cachedOrders })
    }

    logger.info('Fetching active kitchen orders from DB')
    // Define active statuses for the kitchen view
    const activeStatuses = ["pending", "confirmed", "preparing"]
    const orders = await Order.find({
      status: { $in: activeStatuses },
    })
      .populate({
        path: "items.menuItem",
        select: "name image category", // Select only needed fields
      })
      // Consider populating TableId if needed for table number/name
      // .populate({ path: 'TableId', select: 'tableId' }) 
      .sort({ createdAt: 1 }) // Oldest first

    // Format orders for kitchen display
    const formattedOrders = orders.map(order => {
      // Calculate elapsed time in minutes (consider doing this on client)
      const elapsedMinutes = Math.floor((new Date() - order.createdAt) / (1000 * 60))
      const elapsedTimeString = `${Math.floor(elapsedMinutes / 60)}:${(elapsedMinutes % 60).toString().padStart(2, "0")}`

      return {
        id: order._id.toString(),
        orderNumber: order._id.toString().slice(-6).toUpperCase(),
        items: order.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          specialInstructions: item.specialInstructions || '',
          category: item.menuItem?.category || null, // Use optional chaining
        })),
        orderType: order.orderType,
        // Use deviceId from order if TableId isn't populated/available
        tableId: order.TableId?.tableId || order.deviceId || null, 
        status: order.status,
        createdAt: order.createdAt,
        elapsedTime: elapsedTimeString, 
      }
    })

    // Cache the result for 30 seconds (short TTL for active orders)
    await setCache(KITCHEN_ORDERS_CACHE, formattedOrders, 30)

    res.status(200).json({ orders: formattedOrders })
  } catch (error) {
    logger.error('Error getting active kitchen orders:', error)
    next(error)
  }
}

// Get completed kitchen orders (for Past Orders screen)
export const getCompletedKitchenOrders = async (req, res, next) => {
  try {
    // Try to get from cache first
    const cachedOrders = await getCache(COMPLETED_ORDERS_CACHE)
    
    if (cachedOrders) {
      logger.info('Serving completed kitchen orders from cache')
      return res.status(200).json({ orders: cachedOrders })
    }

    logger.info('Fetching completed kitchen orders from DB')
    // Define completed statuses for this view
    const completedStatuses = ["ready_for_pickup", "completed", "cancelled"] 
    const limit = parseInt(req.query.limit || '50', 10) // Base 10

    const orders = await Order.find({
      status: { $in: completedStatuses },
    })
      .populate({
        path: "items.menuItem",
        select: "name category", // Select only needed fields
      })
      // .populate({ path: 'TableId', select: 'tableId' })
      .sort({ updatedAt: -1 }) // Most recently updated first
      .limit(limit)

    // Format orders for display
    const formattedOrders = orders.map(order => ({
      id: order._id.toString(),
      orderNumber: order._id.toString().slice(-6).toUpperCase(),
      items: order.items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        specialInstructions: item.specialInstructions || '',
        category: item.menuItem?.category || null,
      })),
      orderType: order.orderType,
      tableId: order.TableId?.tableId || order.deviceId || null,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt, // Include updated time for completed orders
    }))

    // Cache the result for 60 seconds (longer TTL for completed)
    await setCache(COMPLETED_ORDERS_CACHE, formattedOrders, 60)

    res.status(200).json({ orders: formattedOrders })
  } catch (error) {
    logger.error('Error fetching completed kitchen orders:', error)
    next(error)
  }
}

// Update payment status
export const updatePaymentStatus = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { paymentStatus, paymentId } = req.body;

    if (!paymentStatus) {
      return res.status(400).json({ message: "Payment status is required" });
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Update payment status
    order.paymentStatus = paymentStatus;
    if (paymentId) {
      order.paymentId = paymentId;
    }
    await order.save();

    // If this order is part of a session and all orders are paid, update session status
    let sessionUpdated = false;
    const session = await TableSession.findOne({ orders: orderId });
    if (session && session.status === "payment_pending") {
      const unpaidOrders = await Order.countDocuments({
        _id: { $in: session.orders },
        paymentStatus: { $ne: "paid" },
      });

      if (unpaidOrders === 0) {
        session.status = "closed";
        session.endTime = new Date();
        await session.save();
        sessionUpdated = true;

        // Update table status
        const table = await Table.findById(session.tableId);
        if (table) {
          table.status = "cleaning";
          table.currentSession = null;
          await table.save();
        }
      }
    }

    // --- Cache Invalidation ---
    if (redisService.isConnected()) {
      // 1. Invalidate order details cache
      const orderCacheKey = `${ORDER_DETAILS_CACHE_PREFIX}${orderId}`;
      await deleteCache(orderCacheKey);
      logger.info(`Invalidated cache for key: ${orderCacheKey} (payment status updated)`);
      
      // 2. Invalidate user orders cache if user ID is available
      if (order.user) {
        const userCacheKey = `${USER_ORDERS_CACHE_PREFIX}${order.user}`;
        await deleteCache(userCacheKey);
        logger.info(`Invalidated cache for key: ${userCacheKey} (payment status updated)`);
      }
      
      // 3. Invalidate session orders cache if this order is part of a session
      if (session) {
        const sessionCacheKey = `${SESSION_ORDERS_CACHE_PREFIX}${session._id}`;
        await deleteCache(sessionCacheKey);
        logger.info(`Invalidated cache for key: ${sessionCacheKey} (payment status updated)`);
      }
    }
    // --- End Cache Invalidation ---

    res.status(200).json({
      message: "Payment status updated successfully",
      order: {
        id: order._id,
        paymentStatus: order.paymentStatus,
        paymentId: order.paymentId,
      },
      sessionUpdated,
    });
  } catch (error) {
    logger.error(`Error in updatePaymentStatus: ${error.message}`, error);
    next(error);
  }
};
export const submitOrderRatings = async (req, res) => {
  try {
    const userId = req.user.id; // Depuis le middleware d'authentification
    const { orderId } = req.params; 
    const { itemRatings } = req.body; // Attendu comme [{ menuItemId: "...", ratingValue: N }, ...]

    if (!itemRatings || !Array.isArray(itemRatings) || itemRatings.length === 0) {
      return res.status(400).json({ message: "Aucune notation fournie." });
    }

    // 1. Valider la commande et les droits de l'utilisateur
    const order = await Order.findOne({ _id: orderId, user: userId });
    if (!order) {
       return res.status(403).json({ message: "Commande non trouvée ou accès non autorisé pour noter." });
    }
    // Optionnel: Permettre de noter uniquement les commandes avec un certain statut (ex: "delivered")
    if (order.status !== "delivered") { 
        return res.status(400).json({ message: "Vous ne pouvez noter que les commandes qui ont été livrées." });
    }

    const operationsForRatingCollection = [];
    const itemRatingUpdatesForOrder = new Map(); 

    for (const itemRating of itemRatings) {
      if (!itemRating.menuItemId || typeof itemRating.ratingValue !== 'number' || itemRating.ratingValue < 1 || itemRating.ratingValue > 5) {
        console.warn(`Notation invalide ou menuItemId manquant pour l'article: ${JSON.stringify(itemRating)}. Ignorée.`);
        continue; 
      }
      
      operationsForRatingCollection.push({
        updateOne: {
          filter: { user: userId, menuItem: itemRating.menuItemId },
          update: {
            $set: {
              rating: itemRating.ratingValue,
              source: "manual_order", 
              user: userId,
              menuItem: itemRating.menuItemId,
            },
          },
          upsert: true, 
        },
      });

      itemRatingUpdatesForOrder.set(itemRating.menuItemId.toString(), itemRating.ratingValue);
    }

    if (operationsForRatingCollection.length === 0 && itemRatingUpdatesForOrder.size === 0) {
      return res.status(400).json({ message: "Aucune notation valide fournie." });
    }

    // 2. Mettre à jour la collection globale Rating (pour le système de recommandation)
    if (operationsForRatingCollection.length > 0) {
      await Rating.bulkWrite(operationsForRatingCollection);
      logger.info("Notations globales enregistrées/mises à jour dans la collection Rating.");
    }

    // 3. Mettre à jour les notes DANS le document Order lui-même
    let orderItemsUpdatedCount = 0;
    order.items.forEach(item => {
      // Assurez-vous que item.menuItem existe et n'est pas null
      if (item.menuItem) {
        const menuItemIdStr = item.menuItem.toString(); 
        if (itemRatingUpdatesForOrder.has(menuItemIdStr)) {
          // IMPORTANT: Assurez-vous que votre orderItemSchema dans order.model.js
          // a un champ comme 'userRating: { type: Number }'
          item.currentUserRating = itemRatingUpdatesForOrder.get(menuItemIdStr); 
          orderItemsUpdatedCount++;
        }
      }
    });

    if (orderItemsUpdatedCount > 0) {
      // Marquer le tableau 'items' comme modifié est crucial pour Mongoose
      // lorsque l'on modifie des éléments d'un tableau d'objets imbriqués.
      order.markModified('items'); 
      await order.save();
      logger.info(`${orderItemsUpdatedCount} article(s) noté(s) dans le document Order ID: ${orderId}`);
    } else {
      logger.info(`Aucun article à mettre à jour avec une note dans le document Order ID: ${orderId}. Cela peut arriver si les menuItemId ne correspondent pas ou si les notes sont invalides.`);
    }

    // --- Cache Invalidation ---
    if (redisService.isConnected && redisService.isConnected()) {
      // 1. Invalidate order details cache
      const orderCacheKey = `${ORDER_DETAILS_CACHE_PREFIX}${orderId}`;
      await deleteCache(orderCacheKey);
      logger.info(`Invalidated cache for key: ${orderCacheKey} (ratings updated)`);
      
      // 2. Invalidate user orders cache
      const userCacheKey = `${USER_ORDERS_CACHE_PREFIX}${userId}`;
      await deleteCache(userCacheKey);
      logger.info(`Invalidated cache for key: ${userCacheKey} (ratings updated)`);
      
      // 3. Invalidate ratings cache if you have one
      const ratingsCacheKey = `${RATINGS_CACHE_PREFIX}${userId}`;
      await deleteCache(ratingsCacheKey);
      logger.info(`Invalidated cache for key: ${ratingsCacheKey} (ratings updated)`);
    }
    // --- End Cache Invalidation ---

    res.status(200).json({ message: "Notations enregistrées avec succès." });

  } catch (error) {
    logger.error(`Error in submitOrderRatings: ${error.message}`, error);
    res.status(500).json({ message: "Erreur serveur.", error: error.message });
  }
};