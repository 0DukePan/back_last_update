import { Table } from "../models/table.model.js";
import { Reservation } from "../models/reservation.model.js";
import moment from "moment"; // Pour manipuler les dates/heures
// Import Redis service
import redisService, { getCache, setCache, deleteCache } from '../services/redis.service.js';
import logger from '../middlewares/logger.middleware.js';

// Cache key constants
const AVAILABILITY_CACHE_PREFIX = 'reservation:availability:';
const USER_RESERVATIONS_CACHE_PREFIX = 'reservation:user:';

// Cache expiration times (in seconds)
const AVAILABILITY_CACHE_EXPIRATION = 1800; // 30 minutes
const RESERVATIONS_CACHE_EXPIRATION = 3600; // 1 hour

// Fonction utilitaire pour générer une liste de créneaux horaires
// (exemple : de 19h00 à 22h00, tous les 30 minutes)
const generateTimeSlots = (startTime, endTime, intervalMinutes) => {
  const slots = [];
  let currentTime = moment(startTime, "HH:mm");
  const end = moment(endTime, "HH:mm");

  while (currentTime <= end) {
    slots.push(currentTime.format("HH:mm"));
    currentTime.add(intervalMinutes, "minutes");
  }
  return slots;
};

export const getAvailability = async (req, res) => {
  const { date, guests } = req.query; // date au format "YYYY-MM-DD"
  const numericGuests = parseInt(guests, 10);

  if (!date || isNaN(numericGuests) || numericGuests <= 0) {
    return res.status(400).json({
      message:
        "La date et le nombre de personnes sont requis et doivent être valides.",
    });
  }

  // Create a cache key based on date and guests
  const cacheKey = `${AVAILABILITY_CACHE_PREFIX}${date}:${numericGuests}`;

  try {
    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedAvailability = await getCache(cacheKey);
      if (cachedAvailability) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({ availableSlots: cachedAvailability });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    // 1. Trouver les tables de capacité suffisante
    const availableTables = await Table.find({
      capacity: { $gte: numericGuests },
    });

    if (availableTables.length === 0) {
      return res.status(200).json({
        message: "Aucune table disponible pour ce nombre de personnes.",
        availableSlots: [],
      });
    }

    const availableTableIds = availableTables.map((table) => table._id);

    // 2. Générer les créneaux horaires (exemple : 19:00, 19:30, 20:00...)
    const timeSlots = generateTimeSlots("19:00", "22:00", 30); // À adapter à vos horaires

    const availability = [];

    // 3. Vérifier la disponibilité pour chaque créneau
    for (const timeSlot of timeSlots) {
      const startTime = moment(
        `${date} ${timeSlot}`,
        "YYYY-MM-DD HH:mm"
      ).toDate();
      const endTime = moment(startTime).add(30, "minutes").toDate(); // Durée typique d'une réservation

      // Vérifier s'il existe une réservation pour une table adéquate à ce créneau
      const isReserved = await Reservation.exists({
        tableId: { $in: availableTableIds },
        reservationTime: { $lt: endTime, $gte: startTime }, //  Chevauchement
      });

      availability.push({ time: timeSlot, available: !isReserved }); // Disponible si pas de réservation
    }

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(cacheKey, availability, AVAILABILITY_CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({ availableSlots: availability });
  } catch (error) {
    logger.error(`Error in getAvailability: ${error.message}`, error);
    res.status(500).json({
      message: "Erreur lors de la récupération des disponibilités.",
      error: error.message,
    });
  }
};

export const createReservation = async (req, res) => {
  const {
    reservationTime,
    guests,
    preSelectedMenu,
    specialRequests,
    paymentMethod,
  } = req.body;
  const userId = req.user._id; // Assurez-vous que l'authentification est en place
  const numericGuests = parseInt(guests, 10);

  if (!reservationTime || isNaN(numericGuests) || numericGuests <= 0) {
    return res.status(400).json({
      message:
        "L'heure de réservation et le nombre de personnes sont requis et doivent être valides.",
    });
  }

  try {
    // 1. Trouver les tables de capacité suffisante
    const availableTables = await Table.find({
      capacity: { $gte: numericGuests },
    });

    if (availableTables.length === 0) {
      return res.status(409).json({
        message: "Aucune table n'est disponible pour ce nombre de personnes.",
      });
    }

    const availableTableIds = availableTables.map((table) => table._id);

    // 2. Trouver une table disponible pour ce créneau
    const availableTable = await Table.findOne({
      _id: { $in: availableTableIds },
      _id: {
        $nin: (
          await Reservation.find({ reservationTime })
        ).map((r) => r.tableId),
      }, // N'est pas réservée
    });

    if (!availableTable) {
      return res.status(409).json({
        message:
          "Toutes les tables adéquates sont déjà réservées pour ce créneau.",
      });
    }

    // 3. Créer la réservation
    const reservation = new Reservation({
      userId: userId,
      tableId: availableTable._id,
      reservationTime: new Date(reservationTime), // S'assurer que c'est bien un objet Date
      guests: numericGuests,
      preSelectedMenu: preSelectedMenu,
      specialRequests: specialRequests,
      paymentMethod: paymentMethod, // <-- AJOUT : Sauvegarder le moyen de paiement
    });

    await reservation.save();

    // --- Cache Invalidation ---
    if (redisService.isConnected()) {
      // 1. Invalidate user's reservations cache
      const userCacheKey = `${USER_RESERVATIONS_CACHE_PREFIX}${userId}`;
      await deleteCache(userCacheKey);
      logger.info(`Invalidated cache for key: ${userCacheKey} (new reservation created)`);
      
      // 2. Invalidate availability cache for this date and guest count
      // Extract date from reservationTime
      const reservationDate = moment(reservationTime).format('YYYY-MM-DD');
      const availabilityCacheKey = `${AVAILABILITY_CACHE_PREFIX}${reservationDate}:${numericGuests}`;
      await deleteCache(availabilityCacheKey);
      logger.info(`Invalidated cache for key: ${availabilityCacheKey} (new reservation created)`);
      
      // 3. Also invalidate availability caches for other guest counts on the same date
      // This is necessary because a table being reserved affects availability for all guest counts
      // We'll use a simple approach of invalidating for common guest counts
      for (let i = 1; i <= 10; i++) {
        if (i !== numericGuests) {
          const otherGuestsCacheKey = `${AVAILABILITY_CACHE_PREFIX}${reservationDate}:${i}`;
          await deleteCache(otherGuestsCacheKey);
          logger.info(`Invalidated cache for key: ${otherGuestsCacheKey} (related to new reservation)`);
        }
      }
    }
    // --- End Cache Invalidation ---

    res
      .status(201)
      .json({ message: "Réservation créée avec succès.", reservation });
  } catch (error) {
    logger.error(`Error in createReservation: ${error.message}`, error);
    res.status(500).json({
      message: "Erreur lors de la création de la réservation.",
      error: error.message,
    });
  }
};

export const getReservations = async (req, res) => {
  try {
    // L'ID de l'utilisateur est fourni par le middleware 'protect' via req.user
    const userId = req.user._id;

    if (!userId) {
      // Normalement, 'protect' devrait déjà gérer ça, mais sécurité supplémentaire
      return res.status(401).json({ message: "Utilisateur non authentifié." });
    }

    // Create a cache key for this user's reservations
    const cacheKey = `${USER_RESERVATIONS_CACHE_PREFIX}${userId}`;

    // Try to get from cache first
    if (redisService.isConnected()) {
      const cachedReservations = await getCache(cacheKey);
      if (cachedReservations) {
        logger.info(`Cache hit for key: ${cacheKey}`);
        return res.status(200).json({
          message: "Réservations récupérées avec succès (from cache)",
          reservations: cachedReservations,
        });
      }
      logger.info(`Cache miss for key: ${cacheKey}`);
    } else {
      logger.warn(`Redis not connected, skipping cache check for key: ${cacheKey}`);
    }

    // Récupérer toutes les réservations pour cet utilisateur
    // Trier par date de réservation la plus récente en premier (descendant)
    const reservations = await Reservation.find({ userId: userId })
      .sort({ reservationTime: -1 }) // Trier par reservationTime descendant
      .populate({
          path: 'preSelectedMenu.menuItemId', // Chemin vers l'ID dans le tableau
          model: 'MenuItem', // Modèle référencé
          select: 'name price image' // Retourner le nom, prix, image du plat (adaptez)
      });

    if (!reservations) {
      // find() retourne un tableau vide si rien n'est trouvé, pas null, donc cette condition est rarement utile
      // sauf si une erreur se produit.
      return res.status(404).json({ message: "Aucune réservation trouvée pour cet utilisateur." });
    }

    logger.info(`Récupération de ${reservations.length} réservations pour l'utilisateur ${userId}`);

    // Store in cache if Redis is connected
    if (redisService.isConnected()) {
      await setCache(cacheKey, reservations, RESERVATIONS_CACHE_EXPIRATION);
      logger.info(`Cached data for key: ${cacheKey}`);
    }

    res.status(200).json({
      message: "Réservations récupérées avec succès",
      reservations: reservations, // Envoyer le tableau des réservations
    });

  } catch (error) {
    logger.error(`Error in getReservations: ${error.message}`, error);
    res.status(500).json({
      message: "Erreur lors de recherche des réservations.",
      error: error.message,
    });
  }
};