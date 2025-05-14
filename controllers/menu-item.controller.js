import MenuItem from "../models/menuItem.model.js";
import { uploadImage, deleteImage } from "../services/cloudinaryService.js";
// Import Redis service
import redisService, { getCache, setCache, deleteCache, getValue, setValue } from '../services/redis.service.js';
import logger from '../middlewares/logger.middleware.js';

// Cache key constants
const ALL_MENU_ITEMS_CACHE = 'menu:all';
const MENU_ITEM_DETAILS_CACHE_PREFIX = 'menu:item:';
const POPULAR_MENU_ITEMS_CACHE = 'menu:popular';
const SEARCH_MENU_ITEMS_CACHE_PREFIX = 'menu:search:';
const DIETARY_MENU_ITEMS_CACHE_PREFIX = 'menu:dietary:';
const HEALTH_MENU_ITEMS_CACHE_PREFIX = 'menu:health:';

// Cache expiration time (e.g., 1 hour)
const CACHE_EXPIRATION = 3600;

// Get all menu items
export const getAllMenuItems = async (req, res, next) => {
  try {
    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedMenuItems = await getCache(ALL_MENU_ITEMS_CACHE);
      if (cachedMenuItems) {
        logger.info(`Cache hit for key: ${ALL_MENU_ITEMS_CACHE}`);
        return res.status(200).json({ menuItems: cachedMenuItems });
      }
      logger.info(`Cache miss for key: ${ALL_MENU_ITEMS_CACHE}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${ALL_MENU_ITEMS_CACHE}`);
    }

    // No population needed or possible for a string category
    const menuItems = await MenuItem.find({ isAvailable: true });

    // Format response (category is just a string)
    const formattedMenuItems = menuItems.map((item) => ({
      id: item._id,
      name: item.name,
      description: item.description,
      price: item.price,
      image: item.image,
      category: item.category, // Direct string access
      dietaryInfo: item.dietaryInfo,
      healthInfo: item.healthInfo,
      isPopular: item.isPopular,
      preparationTime: item.preparationTime,
      addons: item.addons,
    }));

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(ALL_MENU_ITEMS_CACHE, formattedMenuItems, CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${ALL_MENU_ITEMS_CACHE}`);
    }

    res.status(200).json({ menuItems: formattedMenuItems });
  } catch (error) {
    next(error);
  }
};

// Get menu items by category name - KEEPING EXISTING IMPLEMENTATION
export const getMenuItemsByCategory = async (req, res, next) => {
  const { categoryName } = req.params; // Get category name from params

  if (!categoryName) {
    return res.status(400).json({ message: "Category name parameter is required." });
  }

  // Define a unique cache key for this category
  const cacheKey = `menu:category:${categoryName}`;

  try {
    // 1. Try fetching from cache first
    if (redisService.isConnected()) {
      const cachedMenuItems = await getCache(cacheKey);
      if (cachedMenuItems) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ menuItems: cachedMenuItems });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
       logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }


    // 2. If cache miss or Redis not connected, fetch from DB
    const menuItems = await MenuItem.find({
      category: categoryName,
      isAvailable: true,
    });

    // Format response
    const formattedMenuItems = menuItems.map((item) => ({
      id: item._id,
      name: item.name,
      description: item.description,
      price: item.price,
      image: item.image,
      category: item.category, // Direct string access
      dietaryInfo: item.dietaryInfo,
      healthInfo: item.healthInfo,
      preparationTime: item.preparationTime,
      isPopular: item.isPopular,
      addons: item.addons,
    }));

     // 3. Store the result in cache if Redis is connected
     if (redisService.isConnected()) {
        await setCache(cacheKey, formattedMenuItems, CACHE_EXPIRATION);
        logger.info(`Cached data for key: ${cacheKey}`);
     }


    res.status(200).json({ menuItems: formattedMenuItems });
  } catch (error) {
    next(error);
  }
};

// Get menu item details
export const getMenuItemDetails = async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const cacheKey = `${MENU_ITEM_DETAILS_CACHE_PREFIX}${itemId}`;

    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedMenuItem = await getCache(cacheKey);
      if (cachedMenuItem) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ menuItem: cachedMenuItem });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    // No population needed
    const menuItem = await MenuItem.findById(itemId);

    if (!menuItem) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    // Format response (category is a string)
    const formattedMenuItem = {
      id: menuItem._id,
      name: menuItem.name,
      description: menuItem.description,
      price: menuItem.price,
      image: menuItem.image,
      category: menuItem.category, // Direct string access
      dietaryInfo: menuItem.dietaryInfo,
      healthInfo: menuItem.healthInfo,
      preparationTime: menuItem.preparationTime,
      isPopular: menuItem.isPopular,
      addons: menuItem.addons,
    };

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(cacheKey, formattedMenuItem, CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({ menuItem: formattedMenuItem });
  } catch (error) {
    next(error);
  }
};

// Create new menu item
export const createMenuItem = async (req, res, next) => {
  try {
    const {
      name,
      description,
      price,
      category, // This is now expected to be a string
      dietaryInfo,
      healthInfo,
      isAvailable,
      isPopular,
      addons,
      preparationTime,
      cfFeatures,
      matrixIndex,
    } = req.body;
    let { image } = req.body; // Can be base64 or potentially null/URL

    if (!name || !price || !category) {
      return res
        .status(400)
        .json({ message: "Name, price, and category (string) are required" });
    }

    // No validation against MenuCategory needed

    let imageUrl = null; // Default to null

    // Use the cloudinary service to upload if image data provided
    if (image && typeof image === 'string') { // Service handles base64 or existing URLs
      try {
        const uploadResult = await uploadImage(image, "hungerz_kiosk/menu_items"); //
        imageUrl = uploadResult.secure_url;
      } catch (uploadError) {
         console.error("Cloudinary service upload error during create:", uploadError);
         // Pass the specific error from the service
         return next(uploadError);
      }
    }

    // Create new menu item instance
    const menuItem = new MenuItem({
      name,
      description,
      price,
      image: imageUrl, // Use the URL from service or null
      category, // Assign the string category directly
      dietaryInfo: dietaryInfo || {},
      healthInfo: healthInfo || {},
      cfFeatures,
      matrixIndex,
      addons : addons || [],
      isAvailable: isAvailable !== undefined ? isAvailable : true,
      isPopular: isPopular !== undefined ? isPopular : false,
      preparationTime: preparationTime || 15,
    });

    await menuItem.save();

    // --- Cache Invalidation ---
    if (redisService.isConnected()) {
      // Invalidate category cache
      const categoryKey = `menu:category:${menuItem.category}`;
      await deleteCache(categoryKey);
      logger.info(`Invalidated cache for key: ${categoryKey} (item created)`);
      
      // Invalidate all items cache
      await deleteCache(ALL_MENU_ITEMS_CACHE);
      logger.info(`Invalidated cache for key: ${ALL_MENU_ITEMS_CACHE} (item created)`);
      
      // Invalidate popular items cache if new item is popular
      if (menuItem.isPopular) {
        await deleteCache(POPULAR_MENU_ITEMS_CACHE);
        logger.info(`Invalidated cache for key: ${POPULAR_MENU_ITEMS_CACHE} (popular item created)`);
      }
      
      // Since we don't have deleteCacheByPattern, we need to handle dietary and health caches differently
      // For simplicity, we'll invalidate specific dietary/health caches based on the new item's properties
      if (dietaryInfo) {
        for (const [key, value] of Object.entries(dietaryInfo)) {
          if (value === true) {
            await deleteCache(`${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key}`);
            logger.info(`Invalidated cache for key: ${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key} (item with dietary info created)`);
          }
        }
      }
      
      if (healthInfo) {
        for (const [key, value] of Object.entries(healthInfo)) {
          if (value === true) {
            await deleteCache(`${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key}`);
            logger.info(`Invalidated cache for key: ${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key} (item with health info created)`);
          }
        }
      }
    }
    // --- End Cache Invalidation ---

    // Return the created item (category is a string)
    res.status(201).json({
      message: "Menu item created successfully",
      menuItem: {
        id: menuItem._id,
        name: menuItem.name,
        price: menuItem.price,
        image: menuItem.image,
        category: menuItem.category, // String category
      },
    });
  } catch (error) {
    next(error);
  }
};

// Update menu item
export const updateMenuItem = async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const updateData = req.body; // Get all potential update fields
    let { image } = req.body; // Handle image separately

    const menuItem = await MenuItem.findById(itemId);

    if (!menuItem) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    const oldImageUrl = menuItem.image;
    const oldCategory = menuItem.category; // Store old category for invalidation
    let newImageUrl = oldImageUrl; // Assume no change initially

    // Handle image update using the service
    if (image !== undefined) { // Check if image field is present in the request (could be null)
      if (image === null) { // Explicitly setting image to null
          newImageUrl = null;
          if (oldImageUrl && oldImageUrl.includes("cloudinary.com")) {
              try {
                  await deleteImage(oldImageUrl);
                  logger.info(`Deleted old menu item image via service (set to null): ${oldImageUrl}`);
              } catch (deleteError) {
                  logger.error(`Service error deleting old menu item image: ${deleteError.message}`);
              }
          }
      } else if (typeof image === 'string') { // If image is provided (base64 or URL)
           try {
               const uploadResult = await uploadImage(image, "hungerz_kiosk/menu_items"); // Use service
               newImageUrl = uploadResult.secure_url; // Service handles base64 or existing URLs

               // Delete old image only if upload was successful and URL is different
               if (oldImageUrl && oldImageUrl.includes("cloudinary.com") && oldImageUrl !== newImageUrl) {
                   try {
                       await deleteImage(oldImageUrl); // Use service, passing the full URL
                       logger.info(`Deleted old menu item image via service: ${oldImageUrl}`);
                   } catch (deleteError) {
                       logger.error(`Service error deleting old menu item image: ${deleteError.message}`);
                       // Log error, but allow update to proceed
                   }
               }
           } catch (uploadError) {
               logger.error("Cloudinary service upload error during update:", uploadError);
               return next(uploadError); // Pass error from service
           }
      }
      // Update image field only if it actually changed
      if (newImageUrl !== oldImageUrl) {
          menuItem.image = newImageUrl;
      }
    }
    // Remove image from updateData so it's not directly assigned below
    delete updateData.image;

    // Store old dietary and health info for cache invalidation
    const oldDietaryInfo = { ...menuItem.dietaryInfo };
    const oldHealthInfo = { ...menuItem.healthInfo };
    const oldIsPopular = menuItem.isPopular;

    // Update other fields dynamically
    Object.keys(updateData).forEach(key => {
        // Ensure we don't overwrite critical fields unintentionally or set undefined
        if (updateData[key] !== undefined && key !== '_id' && key !== 'image') {
             menuItem[key] = updateData[key];
        }
    });

    const updatedMenuItem = await menuItem.save();
    const newCategory = updatedMenuItem.category; // Get the potentially updated category

    // --- Cache Invalidation ---
    if (redisService.isConnected()) {
      // Invalidate the old category cache if category changed
      if (oldCategory !== newCategory) {
          const oldCacheKey = `menu:category:${oldCategory}`;
          await deleteCache(oldCacheKey);
          logger.info(`Invalidated cache for key: ${oldCacheKey} (category changed)`);
      }
      
      // Invalidate the new/current category cache
      const newCacheKey = `menu:category:${newCategory}`;
      await deleteCache(newCacheKey);
      logger.info(`Invalidated cache for key: ${newCacheKey} (item updated)`);

      // Invalidate item details cache
      const itemCacheKey = `${MENU_ITEM_DETAILS_CACHE_PREFIX}${updatedMenuItem._id}`;
      await deleteCache(itemCacheKey);
      logger.info(`Invalidated cache for key: ${itemCacheKey} (item updated)`);
      
      // Invalidate all items cache
      await deleteCache(ALL_MENU_ITEMS_CACHE);
      logger.info(`Invalidated cache for key: ${ALL_MENU_ITEMS_CACHE} (item updated)`);
      
      // Invalidate popular items cache if popularity changed
      if (oldIsPopular !== updatedMenuItem.isPopular || updateData.isAvailable !== undefined) {
        await deleteCache(POPULAR_MENU_ITEMS_CACHE);
        logger.info(`Invalidated cache for key: ${POPULAR_MENU_ITEMS_CACHE} (item popularity/availability changed)`);
      }
      
      // Invalidate dietary caches if dietary info changed
      if (updateData.dietaryInfo !== undefined) {
        // Invalidate caches for old dietary preferences that were true
        for (const [key, value] of Object.entries(oldDietaryInfo)) {
          if (value === true) {
            await deleteCache(`${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key}`);
            logger.info(`Invalidated cache for key: ${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key} (dietary info changed)`);
          }
        }
        
        // Invalidate caches for new dietary preferences that are true
        for (const [key, value] of Object.entries(updatedMenuItem.dietaryInfo)) {
          if (value === true) {
            await deleteCache(`${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key}`);
            logger.info(`Invalidated cache for key: ${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key} (dietary info changed)`);
          }
        }
      }
      
      // Invalidate health caches if health info changed
      if (updateData.healthInfo !== undefined) {
        // Invalidate caches for old health preferences that were true
        for (const [key, value] of Object.entries(oldHealthInfo)) {
          if (value === true) {
            await deleteCache(`${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key}`);
            logger.info(`Invalidated cache for key: ${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key} (health info changed)`);
          }
        }
        
        // Invalidate caches for new health preferences that are true
        for (const [key, value] of Object.entries(updatedMenuItem.healthInfo)) {
          if (value === true) {
            await deleteCache(`${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key}`);
            logger.info(`Invalidated cache for key: ${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key} (health info changed)`);
          }
        }
      }
    }
    // --- End Cache Invalidation ---

    res.status(200).json({
      message: "Menu item updated successfully",
      menuItem: {
        id: updatedMenuItem._id,
        name: updatedMenuItem.name,
        price: updatedMenuItem.price,
        image: updatedMenuItem.image,
        category: updatedMenuItem.category, // String category
        isAvailable: updatedMenuItem.isAvailable,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Delete menu item
export const deleteMenuItem = async (req, res, next) => {
  try {
    const { itemId } = req.params;

    const menuItem = await MenuItem.findById(itemId);

    if (!menuItem) {
      return res.status(404).json({ message: "Menu item not found" });
    }
    const categoryToDeleteFrom = menuItem.category; // Get category before deleting

    // Attempt to delete image from Cloudinary using the service
    if (menuItem.image && menuItem.image.includes("cloudinary.com")) {
      try {
        // Call service's deleteImage with the full URL
        const result = await deleteImage(menuItem.image);
        logger.info(`Attempted deletion via service for image: ${menuItem.image} - Result: ${result.result}`);
      } catch (deleteError) {
        logger.error(`Service error deleting menu item image: ${deleteError.message}`);
        // Log error, but continue with item deletion
      }
    }

    // Store dietary and health info for cache invalidation before deleting
    const dietaryInfo = { ...menuItem.dietaryInfo };
    const healthInfo = { ...menuItem.healthInfo };
    const isPopular = menuItem.isPopular;

    // Delete the menu item from the database
    await MenuItem.findByIdAndDelete(itemId);

    // --- Cache Invalidation ---
    if (redisService.isConnected()) {
      // Invalidate category cache
      const cacheKey = `menu:category:${categoryToDeleteFrom}`;
      await deleteCache(cacheKey);
      logger.info(`Invalidated cache for key: ${cacheKey} (item deleted)`);
      
      // Invalidate item details cache
      const itemCacheKey = `${MENU_ITEM_DETAILS_CACHE_PREFIX}${itemId}`;
      await deleteCache(itemCacheKey);
      logger.info(`Invalidated cache for key: ${itemCacheKey} (item deleted)`);
      
      // Invalidate all items cache
      await deleteCache(ALL_MENU_ITEMS_CACHE);
      logger.info(`Invalidated cache for key: ${ALL_MENU_ITEMS_CACHE} (item deleted)`);
      
      // Invalidate popular items cache if item was popular
      if (isPopular) {
        await deleteCache(POPULAR_MENU_ITEMS_CACHE);
        logger.info(`Invalidated cache for key: ${POPULAR_MENU_ITEMS_CACHE} (popular item deleted)`);
      }
      
      // Invalidate dietary caches for preferences that were true
      for (const [key, value] of Object.entries(dietaryInfo)) {
        if (value === true) {
          await deleteCache(`${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key}`);
          logger.info(`Invalidated cache for key: ${DIETARY_MENU_ITEMS_CACHE_PREFIX}${key} (item with dietary info deleted)`);
        }
      }
      
      // Invalidate health caches for preferences that were true
      for (const [key, value] of Object.entries(healthInfo)) {
        if (value === true) {
          await deleteCache(`${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key}`);
          logger.info(`Invalidated cache for key: ${HEALTH_MENU_ITEMS_CACHE_PREFIX}${key} (item with health info deleted)`);
        }
      }
    }
    // --- End Cache Invalidation ---

    res.status(200).json({
      message: "Menu item deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// Get popular menu items
export const getPopularMenuItems = async (req, res, next) => {
  try {
    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedMenuItems = await getCache(POPULAR_MENU_ITEMS_CACHE);
      if (cachedMenuItems) {
        logger.info(`Cache hit for key: ${POPULAR_MENU_ITEMS_CACHE}`);
        return res.status(200).json({ menuItems: cachedMenuItems });
      }
      logger.info(`Cache miss for key: ${POPULAR_MENU_ITEMS_CACHE}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${POPULAR_MENU_ITEMS_CACHE}`);
    }

    // No population needed
    const popularItems = await MenuItem.find({ isPopular: true, isAvailable: true })
      .limit(10);

    // Format response (category is a string)
    const formattedMenuItems = popularItems.map((item) => ({
      id: item._id,
      name: item.name,
      description: item.description,
      price: item.price,
      image: item.image,
      category: item.category, // Direct string access
      dietaryInfo: item.dietaryInfo,
      healthInfo: item.healthInfo,
      isPopular: item.isPopular,
      preparationTime: item.preparationTime,
      addons: item.addons,
    }));

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(POPULAR_MENU_ITEMS_CACHE, formattedMenuItems, CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${POPULAR_MENU_ITEMS_CACHE}`);
    }

    res.status(200).json({ menuItems: formattedMenuItems });
  } catch (error) {
    next(error);
  }
};

// Search menu items
export const searchMenuItems = async (req, res, next) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ message: "Search query is required" });
    }

    const cacheKey = `${SEARCH_MENU_ITEMS_CACHE_PREFIX}${query}`;

    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedMenuItems = await getCache(cacheKey);
      if (cachedMenuItems) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ menuItems: cachedMenuItems });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    // No population needed
    const menuItems = await MenuItem.find({
      $or: [
        { name: { $regex: query, $options: "i" } },
        { description: { $regex: query, $options: "i" } },
        { category: { $regex: query, $options: "i" } } // Search category string
      ],
      isAvailable: true,
    });

    // Format response (category is a string)
    const formattedMenuItems = menuItems.map((item) => ({
      id: item._id,
      name: item.name,
      description: item.description,
      price: item.price,
      image: item.image,
      category: item.category, // Direct string access
      dietaryInfo: item.dietaryInfo,
      healthInfo: item.healthInfo,
      isPopular: item.isPopular,
      preparationTime: item.preparationTime,
      addons: item.addons,
    }));

    // Store in cache if Redis is connected (shorter expiration for search results)
    if (redisService.isConnected()) {
      await setCache(cacheKey, formattedMenuItems, 600); // 10 minutes
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({ menuItems: formattedMenuItems });
  } catch (error) {
    next(error);
  }
};

// Get menu items by dietary preferences
export const getMenuItemsByDietary = async (req, res, next) => {
  try {
    const { preference } = req.params;
    const validPreferences = ["vegetarian", "vegan", "glutenFree", "lactoseFree"];

    if (!validPreferences.includes(preference)) {
      return res.status(400).json({ message: "Invalid dietary preference" });
    }

    const cacheKey = `${DIETARY_MENU_ITEMS_CACHE_PREFIX}${preference}`;

    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedMenuItems = await getCache(cacheKey);
      if (cachedMenuItems) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ menuItems: cachedMenuItems });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    const query = { isAvailable: true };
    query[`dietaryInfo.${preference}`] = true;

    const menuItems = await MenuItem.find(query);

    const formattedMenuItems = menuItems.map((item) => ({
      id: item._id,
      name: item.name,
      description: item.description,
      price: item.price,
      image: item.image,
      category: item.category,
      dietaryInfo: item.dietaryInfo,
      healthInfo: item.healthInfo,
      isPopular: item.isPopular,
      preparationTime: item.preparationTime,
      addons: item.addons,
    }));

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(cacheKey, formattedMenuItems, CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({ menuItems: formattedMenuItems });
  } catch (error) {
    next(error);
  }
};

// Get menu items by health preferences
export const getMenuItemsByHealth = async (req, res, next) => {
  try {
    const { preference } = req.params;
    const validPreferences = ["low_carb", "low_fat", "low_sugar", "low_sodium"];

    if (!validPreferences.includes(preference)) {
      return res.status(400).json({ message: "Invalid health preference" });
    }

    const cacheKey = `${HEALTH_MENU_ITEMS_CACHE_PREFIX}${preference}`;

    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedMenuItems = await getCache(cacheKey);
      if (cachedMenuItems) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ menuItems: cachedMenuItems });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    const query = { isAvailable: true };
    query[`healthInfo.${preference}`] = true;

    // No population needed
    const menuItems = await MenuItem.find(query);

    // Format response (category is a string)
    const formattedMenuItems = menuItems.map((item) => ({
      id: item._id,
      name: item.name,
      description: item.description,
      price: item.price,
      image: item.image,
      category: item.category, // Direct string access
      dietaryInfo: item.dietaryInfo,
      healthInfo: item.healthInfo,
      isPopular: item.isPopular,
      preparationTime: item.preparationTime,
      addons: item.addons,
    }));

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(cacheKey, formattedMenuItems, CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({ menuItems: formattedMenuItems });
  } catch (error) {
    next(error);
  }
};