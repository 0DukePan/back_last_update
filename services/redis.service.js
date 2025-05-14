import Redis from 'ioredis';
import logger from '../middlewares/logger.middleware.js'; // Corrected logger path
import dotenv from 'dotenv';

dotenv.config();

// Parse Redis connection string (handles redis:// and rediss:// with credentials)
const getRedisConfig = () => {
  // Use UPSTASH_REDIS_URL environment variable
  const url = process.env.UPSTASH_REDIS_URL || 'redis://localhost:6379';
  logger.info(`---> Using Redis URL: ${url}`);

  try {
    const parsedUrl = new URL(url);
    const config = {
      host: parsedUrl.hostname,
      port: parseInt(parsedUrl.port || '6379', 10), // Ensure port is number
      username: parsedUrl.username || undefined,
      password: parsedUrl.password || undefined,
      // Enable TLS if the protocol is rediss:
      tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
    };
    // Remove undefined keys
    Object.keys(config).forEach(key => config[key] === undefined && delete config[key]);
    logger.debug('Redis config parsed:', { host: config.host, port: config.port, tls: !!config.tls });
    return config;
  } catch (error) {
    logger.error(`Invalid UPSTASH_REDIS_URL environment variable: ${url}. Defaulting to localhost:6379. Error: ${error.message}`);
    // Fallback to default if URL parsing fails
    return {
      host: 'localhost',
      port: 6379
    };
  }
};

// Get parsed config
const redisConnectionConfig = getRedisConfig();

// Create Redis client using ioredis
const redisClient = new Redis({
  ...redisConnectionConfig, // Spread the parsed host, port, user, pass, tls
  // --- ioredis specific options ---
  retryStrategy: (times) => {
    const delay = Math.min(times * 100, 3000); // More aggressive retry up to 3s
    logger.info(`Redis: Retrying connection (attempt ${times})... delay ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,    // Max retries for a single command
  enableReadyCheck: true,     // Ensures connection is truly ready before 'ready' event
  connectTimeout: 10000,      // 10 seconds connection timeout
  // lazyConnect: true,       // Optional: Connect only when first command is issued
});

// Track connection status
let isRedisConnected = false;

// --- Event Handlers ---
redisClient.on('connect', () => {
  logger.info('Redis: Connecting...'); // TCP connection established
});

redisClient.on('ready', () => {
  isRedisConnected = true;
  logger.info('Redis client connected and ready.');
});

redisClient.on('error', (err) => {
  // Don't assume disconnected on every error, some might be command errors
  // isRedisConnected = false;
  logger.error('Redis Client Error:', err.message); // Log concise message
});

redisClient.on('close', () => {
  isRedisConnected = false;
  logger.info('Redis connection closed.'); // Connection closed (e.g., network issue)
});

redisClient.on('reconnecting', (delay) => {
  isRedisConnected = false; // Not connected while reconnecting
  logger.info(`Redis: Reconnecting... (delay ${delay}ms)`);
});

redisClient.on('end', () => {
  // Connection ended permanently (e.g., after .quit() or max retries exceeded)
  isRedisConnected = false;
  logger.info('Redis connection ended permanently.');
});


// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
  logger.info('Closing Redis connection due to application termination (SIGINT)');
  if (redisClient.status === 'ready' || redisClient.status === 'connecting' || redisClient.status === 'reconnecting') {
      await redisClient.quit(); // Gracefully close connection
  }
  process.exit(0);
});
process.on('SIGTERM', async () => {
    logger.info('Closing Redis connection due to application termination (SIGTERM)');
    if (redisClient.status === 'ready' || redisClient.status === 'connecting' || redisClient.status === 'reconnecting') {
        await redisClient.quit();
    }
    process.exit(0);
});

// --- Helper Functions (get/set/delete cache, get/set value) ---

/**
 * Get data from cache (expects JSON string)
 * @param {string} key - Cache key
 * @returns {Promise<any>} - Parsed JSON data or null
 */
export const getCache = async (key) => {
  if (!isRedisConnected) {
    logger.warn('Redis not ready, skipping cache get');
    return null;
  }
  try {
    const cachedData = await redisClient.get(key);
    if (cachedData === null) return null; // Key doesn't exist
    try {
      return JSON.parse(cachedData);
    } catch (parseError) {
      logger.error(`Error parsing JSON from Redis key ${key}:`, parseError.message);
      return null; // Treat parse error as cache miss
    }
  } catch (error) {
    logger.error(`Error getting cache for key ${key}:`, error.message);
    return null;
  }
};

/**
 * Set JSON data in cache with expiration
 * @param {string} key - Cache key
 * @param {any} data - Data to cache (will be JSON.stringified)
 * @param {number} expireTime - Expiration time in seconds
 * @returns {Promise<boolean>} - Success status
 */
export const setCache = async (key, data, expireTime = 3600) => {
  if (!isRedisConnected) {
    logger.warn('Redis not ready, skipping cache set');
    return false;
  }
  try {
    const stringifiedData = JSON.stringify(data);
    // SET key value EX seconds (atomic operation)
    const result = await redisClient.set(key, stringifiedData, 'EX', expireTime);
    return result === 'OK';
  } catch (error) {
    logger.error(`Error setting cache for key ${key}:`, error.message);
    return false;
  }
};

/**
 * Delete a cache entry (or any key)
 * @param {string} key - Cache key
 * @returns {Promise<boolean>} - Success status (true if key existed and was deleted)
 */
export const deleteCache = async (key) => {
  if (!isRedisConnected) {
    logger.warn('Redis not ready, skipping cache delete');
    return false;
  }
  try {
    const result = await redisClient.del(key);
    return result > 0; // DEL returns number of keys deleted
  } catch (error) {
    logger.error(`Error deleting cache for key ${key}:`, error.message);
    return false;
  }
};

/**
 * Set a simple string key-value pair
 * @param {string} key - Key
 * @param {string} value - Value
 * @param {number} expireTime - Expiration time in seconds (optional)
 * @returns {Promise<boolean>} - Success status
 */
export const setValue = async (key, value, expireTime = null) => {
  if (!isRedisConnected) {
    logger.warn('Redis not ready, skipping value set');
    return false;
  }
  try {
    let result;
    if (expireTime) {
      result = await redisClient.set(key, value, 'EX', expireTime);
    } else {
      result = await redisClient.set(key, value);
    }
    return result === 'OK';
  } catch (error) {
    logger.error(`Error setting value for key ${key}:`, error.message);
    return false;
  }
};

/**
 * Get a simple string value by key
 * @param {string} key - Key
 * @returns {Promise<string|null>} - Value or null if key doesn't exist
 */
export const getValue = async (key) => {
  if (!isRedisConnected) {
    logger.warn('Redis not ready, skipping value get');
    return null;
  }
  try {
    return await redisClient.get(key); // Returns null if key doesn't exist
  } catch (error) {
    logger.error(`Error getting value for key ${key}:`, error.message);
    return null;
  }
};

// --- Export functions and client ---
export default {
  getCache,
  setCache,
  deleteCache,
  setValue,
  getValue,
  client: redisClient,
  isConnected: () => isRedisConnected, // Function to check current status
  // NOTE: clearCache (FLUSHALL) and deleteCacheByPattern (KEYS/SCAN) are omitted for safety.
  // Add them back here if explicitly needed, understanding the risks.
}; 