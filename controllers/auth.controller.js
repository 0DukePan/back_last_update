// controllers/authController.js

import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import VerificationToken from "../models/VerificationToken.model.js";

import { generateOTP } from "../lib/utils/helper.js"; // Gardé pour sendOTP

import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library"; // <<<--- AJOUTÉ
import MenuItem from "../models/menuItem.model.js";

dotenv.config();


// This is your WEB Client ID from .env, which your backend identifies as.
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// This is your ANDROID Client ID, which will be the audience of tokens from your Android app.
const GOOGLE_ANDROID_CLIENT_ID = '338835231484-ssj8ohbq7cqdu83gs3iamqlb2lirpv76.apps.googleusercontent.com';
// You might also want to add your iOS client ID here if you have an iOS app:
// const GOOGLE_IOS_CLIENT_ID = 'YOUR_IOS_CLIENT_ID_HERE';

const client = new OAuth2Client(GOOGLE_WEB_CLIENT_ID); // Initialize with the Web Client ID

export const socialLogin = async (req, res, next) => {
  console.log("socialLogin controller invoked");
  const { provider, idToken } = req.body;

  if (provider !== "google") {
    return res
      .status(400)
      .json({
        success: false,
        error: "Seul Google est supporté pour ce flux actuellement.",
      });
  }
  if (!idToken) {
    return res
      .status(400)
      .json({ success: false, error: "Le 'idToken' Google est manquant." });
  }

  try {
    let payload;
    try {
      console.log("Verifying Google idToken...");
      const ticket = await client.verifyIdToken({
        idToken: idToken,
        audience: [
            GOOGLE_WEB_CLIENT_ID,      // Your backend's Web Client ID (from .env)
            GOOGLE_ANDROID_CLIENT_ID,  // Your Android app's Client ID
            // GOOGLE_IOS_CLIENT_ID,   // Add if you have an iOS app
        ],
      });
      payload = ticket.getPayload();
      if (!payload) {
        console.error("Payload Google vide après vérification.");
        throw new Error("Payload Google vide.");
      }
      console.log("Google idToken verified successfully. Payload:", payload);
    } catch (googleError) {
      console.error("Erreur de vérification Google Token:", googleError.message);
      return res
        .status(401)
        .json({ success: false, error: "Token Google invalide ou expiré." });
    }

    const providerId = payload["sub"]; // Google User ID
    const email = payload["email"]?.toLowerCase();
    const name = payload["name"];
    const profileImage = payload["picture"]; // Google profile picture URL

    if (!providerId || !email) {
      console.error("Informations Google (ID ou email) manquantes dans le payload:", payload);
      return res
        .status(400)
        .json({
          success: false,
          error: "Informations Google (ID ou email) manquantes.",
        });
    }

    console.log(`Processing user: GoogleID=${providerId}, Email=${email}`);

    // Find an existing user by their Google ID or email.
    // If found, update their Google social info and potentially name/profile image.
    // If not found, create a new user with the Google info.
    const user = await User.findOneAndUpdate(
      { $or: [{ "social.google.id": providerId }, { email: email }] },
      {
        $set: {
          email: email, // Ensure email is set/updated
          fullName: name, // Update fullName with the name from Google profile
          profileImage: profileImage, // Update profileImage with Google profile picture
          "social.google.id": providerId,
          "social.google.email": email,
          "social.google.name": name,
          // We don't set isVerified or isMobileVerified to true here.
          // Phone verification will handle isMobileVerified.
          // isVerified might be for email verification if you have that flow.
        },
        $setOnInsert: {
          // These values are only set if a new user document is created (upsert: true)
          // mobileNumber will be null or empty initially for new social logins
          // countryCode can be a default or determined later
          countryCode: "+213", // Default or determine based on other info if available
          isVerified: false, // Overall account verification
          isMobileVerified: false, // Mobile specifically not verified yet
          isAdmin: false,
          isRestaurantOwner: false,
          language: payload['locale'] || "fr", // Use language from Google payload or default
          wallet: { balance: 0, transactions: [] }, // Initialize wallet
          favorites: [],
          addresses: [],
          recommandations: [],
          dietaryProfile: { vegetarian: false, vegan: false, glutenFree: false, dairyFree: false },
          healthProfile: { low_carb: false, low_fat: false, low_sugar: false, low_sodium: false },
          // cfParams: {}, // Let Mongoose default handle this if defined in schema
        },
      },
      {
        new: true, // Return the modified document rather than the original
        upsert: true, // Create a new document if no match is found
        setDefaultsOnInsert: true, // Apply schema defaults when upserting
      }
    );

    // The matrixIndex should be automatically assigned by the pre-save hook in your User model if it's a new user.

    console.log(`Utilisateur trouvé/créé via Google: ID=${user._id}, Mobile Vérifié=${user.isMobileVerified}`);

    // Respond to the Flutter app.
    // The Flutter app's AuthCubit will use 'userId' and 'mobileRequired'.
    res.status(200).json({
      success: true,
      message: "Liaison Google réussie. Numéro de téléphone requis si non déjà fourni et vérifié.",
      userId: user._id.toString(), // Send user ID
      mobileRequired: !user.isMobileVerified, // True if mobile is not verified
    });

  } catch (error) {
    console.error("Erreur interne dans socialLogin après la vérification du token:", error);
    // Pass error to the global error handler
    next(error);
  }
};

// --- FIN SOCIAL LOGIN MODIFIÉ ---

// --- ADAPTATION SUGGÉRÉE pour sendOTP ---
// Pour pouvoir l'appeler après socialLogin en passant l'userId
export const sendOTP = async (req, res, next) => {
  console.log("sendOTPokkkkkkkkkkkkkkk");
  try {
    // Recevoir aussi userId (optionnel)
    const { mobileNumber, countryCode, userId } = req.body;

    if (!mobileNumber) {
      return res
        .status(400)
        .json({ success: false, error: "Numéro de mobile manquant." });
    }

    const otp = generateOTP(6);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    let user;
    if (userId) {
      // Si userId est fourni (cas après socialLogin), trouver par ID et mettre à jour le numéro
      user = await User.findById(userId);
      if (!user) {
        return res
          .status(404)
          .json({
            success: false,
            error: "Utilisateur non trouvé pour l'ID fourni.",
          });
      }
      // Vérifier si le numéro est différent et non vérifié avant de mettre à jour ?
      // Ou toujours mettre à jour ? Pour l'instant, on met à jour.
      user.mobileNumber = mobileNumber;
      user.countryCode = countryCode || user.countryCode; // Garder l'ancien code pays si non fourni
      user.isMobileVerified = false; // Réinitialiser si le numéro change
      user.isVerified = false; // Réinitialiser si le numéro change
      await user.save();
      console.log(
        `Utilisateur ${userId} trouvé, numéro mis à jour: ${mobileNumber}`
      );
    } else {
      // Cas original: trouver/créer par numéro de mobile (connexion/inscription par tél seul)
      user = await User.findOneAndUpdate(
        { mobileNumber },
        {
          $set: { countryCode }, // Met à jour le countryCode si user existe
          // $setOnInsert: Définit les valeurs seulement si NOUVEL user par numéro
          $setOnInsert: {
            mobileNumber: mobileNumber, // Nécessaire ici car clé de recherche
            isVerified: false,
            isMobileVerified: false,
            // ... autres valeurs par défaut comme avant ...
            wallet: { balance: 0 },
            favorites: [],
            addresses: [],
            recommandations: [],
            dietaryProfile: {},
            healthProfile: {},
            cfParams: {},
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      console.log(
        `Utilisateur trouvé/créé par numéro: ${mobileNumber}, ID=${user._id}`
      );
    }

    // Sauvegarder le token OTP pour cet utilisateur
    await VerificationToken.findOneAndUpdate(
      { userId: user._id },
      { token: otp, expiresAt: otpExpiry, mobileNumber: mobileNumber }, // Stocker le numéro avec le token peut aider
      { upsert: true, new: true } // Crée ou met à jour le token OTP
    );

    console.log(`OTP généré pour ${mobileNumber}: ${otp}`);

    // Envoyer le SMS (logique existante)
    // try {
    //     const smsResult = await sendSMSOTP(mobileNumber, countryCode || user.countryCode, otp);
    //     // ... gestion log succès/échec SMS ...
    // } catch (smsError) { console.error("Erreur envoi SMS:", smsError); }

    // Répondre succès (sans OTP en prod)
    console.log("success");
    return res.status(200).json({
      success: true,
      message: "OTP envoyé avec succès (vérifiez les logs serveur).",
      otp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (error) {
    next(error);
  }
};
// --- FIN ADAPTATION sendOTP ---

// --- verifyOTP (semble OK, génère le token final) ---
export const verifyOTP = async (req, res, next) => {
  try {
    // Recevoir le numéro avec l'OTP est crucial
    const { mobileNumber, otp } = req.body;
    if (!mobileNumber || !otp) {
      return res.status(400).json({ error: "Numéro et OTP requis." });
    }

    // Trouver l'utilisateur PAR NUMERO (car on n'a pas d'autre ID fiable à ce stade)
    const user = await User.findOne({ mobileNumber });
    if (!user)
      return res
        .status(404)
        .json({ error: "Utilisateur non trouvé pour ce numéro." });

    // Trouver le token de vérification VALIDE pour cet user et cet OTP
    const verification = await VerificationToken.findOne({
      userId: user._id,
      token: otp,
      //mobileNumber: mobileNumber, // Assurer que c'est le bon numéro si stocké
      expiresAt: { $gt: new Date() }, // Doit être encore valide
    });
    console.log(`OTP trouvé pour ${mobileNumber}: ${otp}`);
    if (!verification) {
      return res.status(400).json({ error: "Code OTP invalide ou expiré." });
    }

    // --- Succès OTP ---
    user.isVerified = true; // Marquer l'utilisateur comme vérifié globalement
    user.isMobileVerified = true; // Marquer le mobile comme vérifié
    await user.save();
    // Supprimer le token OTP pour qu'il ne soit pas réutilisé
    await VerificationToken.deleteOne({ _id: verification._id });

    // --- Générer le TOKEN DE SESSION FINAL ---
    // const token = jwt.sign(
    //     { userId: user._id }, // Payload du token
    //     process.env.ACCESS_TOKEN_SECRET, // Clé secrète
    //     { expiresIn: process.env.JWT_EXPIRES_IN || "30d" } // Durée de vie
    // );

    // console.log(`OTP vérifié pour ${mobileNumber}. Token JWT généré.`);

    // Renvoyer le token et les infos utilisateur
    // Adapter les champs renvoyés si nécessaire pour correspondre à UserModel Flutter
    res.json({
      success: true,
      message: "OTP vérifié avec succès. Veuillez fournir les préférences.",
      userId: user._id, // Renvoyer l'ID de l'utilisateur trouvé/vérifié
      // user: {
      //   _id: user._id,
      //   fullName: user.fullName,
      //   email: user.email,
      //   mobileNumber: user.mobileNumber,
      //   countryCode: user.countryCode, // Ajouter si utile pour Flutter
      //   profileImage: user.profileImage, // Ajouter si utile
      //   isVerified: user.isVerified,
      //   isMobileVerified: user.isMobileVerified, // Ajouter
      //   isAdmin: user.isAdmin, // Ajouter si utile
      //   isRestaurantOwner: user.isRestaurantOwner, // Ajouter si utile
      //   dietaryProfile: user.dietaryProfile, // Ajouter si utile
      //   healthProfile: user.healthProfile, // Ajouter si utile
      //   // Renvoyer les données nécessaires pour l'état 'Authenticated' et l'UI
      //   social: user.social || {},
      //   addresses: user.addresses || [],
      //   wallet: { balance: user.wallet?.balance ?? 0 },
      //   favorites: user.favorites || [], // Assurez-vous que ce sont les bons favoris (MenuItem)
      //   recommandations: user.recommandations || [], // Ajouter
      //   // etc.
      // },
    });
  } catch (error) {
    next(error);
  }
};

export const register = async (req, res, next) => {
  try {
    const { fullName, email, mobileNumber, countryCode, deviceToken, deviceInfo } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { email: email && email !== "" ? email : null },
        { mobileNumber },
      ].filter(Boolean),
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: existingUser.email === email 
          ? "Email already in use" 
          : "Mobile number already in use",
      });
    }

    // Create new user
    const user = await User.create({
      fullName,
      email,
      mobileNumber,
      countryCode,
      isVerified: false,
      wallet: { balance: 0 },
      favorites: [],
      addresses: [],
      deviceToken,
      createdAt: new Date(),
    });

    // Generate OTP for verification
    const otp = generateOTP(6);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await VerificationToken.create({
      userId: user._id,
      token: otp,
      expiresAt: otpExpiry,
      attempts: 0,
      lastSent: new Date(),
      mobileNumber: mobileNumber
    });

    // Try to send SMS
    let smsResult = { success: false };
    try {
      smsResult = await sendOTPService(mobileNumber, countryCode, otp);
      
      if (!smsResult.success) {
        winstonLogger.warn(`SMS failed to send to ${mobileNumber}: ${JSON.stringify(smsResult.error)}`);
      } else {
        winstonLogger.info(`SMS sent successfully to ${smsResult.to}`);
      }
    } catch (smsError) {
      winstonLogger.error("SMS sending error:", { error: smsError.message, stack: smsError.stack });
    }

    // Generate tokens
    const tokens = generateTokens(user);

    // Log registration
    winstonLogger.info("New user registered", { 
      userId: user._id, 
      email, 
      mobileNumber 
    });

    // Return response
    res.status(201).json({
      success: true,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: formatUserResponse(user),
      otpSent: smsResult.success,
      // Only include OTP in non-production environments
      ...(process.env.NODE_ENV !== "production" && { otp }),
      expiresAt: otpExpiry,
    });
  } catch (error) {
    winstonLogger.error("Registration error:", { error: error.message, stack: error.stack });
    next(error);
  }
};

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 */
export const logout = async (req, res, next) => {
  try {
    // Clear refresh token
    const user = await User.findById(req.user._id)
    if (user) {
      user.refreshToken = undefined
      await user.save()
    }

    // Clear cookie
    res.clearCookie("refreshToken")

    res.json({
      success: true,
      message: "Logged out successfully",
    })
  } catch (error) {
    winstonLogger.error("Logout error:", { error: error.message, stack: error.stack })
    next(error)
  }
}

export const getMyProfile = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Not authorized",
      })
    }
    const user = req.user
    res.status(200).json({
      success: true,
      user: formatUserResponse(user),
    })
  } catch (error) {
    winstonLogger.error("Get my profile error:", { error: error.message, stack: error.stack })
    next(error)
  }
}

export const authenticate = async (req, res, next) => {
  let accessToken

  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    accessToken = req.headers.authorization.split(" ")[1]
  }

  if (!accessToken) {
    winstonLogger.warn("Authentication attempt failed: Token missing")
    return res.status(401).json({
      success: false,
      message: "Not authorized, token missing",
    })
  }

  try {
    const decoded = jwt.verify(accessToken, process.env.ACCESS_TOKEN_SECRET)

    const user = await User.findById(decoded.userId).select("-refreshToken")
    if (!user) {
      winstonLogger.warn(`Authentication failed: User ${decoded.userId} not found for valid token.`)
      return res.status(401).json({ success: false, message: "User not found" })
    }

    req.user = user
    winstonLogger.info(`Access token valid for user ${user._id}`)
    return next()
  } catch (error) {
    winstonLogger.warn(`Access token verification failed: ${error.message}`)

    if (error instanceof jwt.TokenExpiredError) {
      winstonLogger.info("Access token expired, attempting refresh...")

      const incomingRefreshToken = req.cookies?.refreshToken

      if (!incomingRefreshToken) {
        winstonLogger.warn("Refresh attempt failed: Refresh token missing from cookie")
        return res.status(401).json({
          success: false,
          message: "Access token expired, refresh token missing",
        })
      }

      try {
        const decodedRefresh = jwt.verify(
          incomingRefreshToken,
          process.env.REFRESH_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET,
        )

        const incomingRefreshTokenHash = crypto.createHash("sha256").update(incomingRefreshToken).digest("hex")

        const user = await User.findOne({
          _id: decodedRefresh.userId,
          refreshToken: incomingRefreshTokenHash,
        })

        if (!user) {
          winstonLogger.warn(`Refresh token invalid or user/token mismatch for userId ${decodedRefresh.userId}`)

          res.clearCookie("refreshToken", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
          })
          return res.status(401).json({
            success: false,
            message: "Invalid refresh token",
          })
        }

        const newTokens = generateTokens(user)

        const newRefreshTokenHash = crypto.createHash("sha256").update(newTokens.refreshToken).digest("hex")
        user.refreshToken = newRefreshTokenHash
        user.lastLogin = new Date()
        await user.save()

        res.cookie("refreshToken", newTokens.refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
          maxAge: (Number.parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN) || 30) * 24 * 60 * 60 * 1000,
        })

        res.setHeader("X-Access-Token", newTokens.accessToken)
        winstonLogger.info(`Token refreshed successfully via header for user ${user._id}`)

        req.user = user.toObject()
        delete req.user.refreshToken

        return next()
      } catch (refreshError) {
        winstonLogger.error(`Refresh token validation failed: ${refreshError.message}`)

        res.clearCookie("refreshToken", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        })
        return res.status(401).json({
          success: false,
          message: "Refresh token invalid or expired",
        })
      }
    } else {
      winstonLogger.warn(`Authentication failed: Access token invalid (reason: ${error.message})`)
      return res.status(401).json({
        success: false,
        message: "Token is invalid",
      })
    }
  }
}
export const submitPreferences = async (req, res, next) => {
  // Récupérer les données envoyées par Flutter
  // Exemple: { userId: '...', preferences: { dietaryProfile: {...}, healthProfile: {...} } }
  const { userId, preferences } = req.body;

  // --- Validation ---
  if (!userId) {
    return res.status(400).json({ success: false, error: "userId manquant." });
  }
  if (!preferences || typeof preferences !== "object") {
    return res
      .status(400)
      .json({
        success: false,
        error: "Données de préférences invalides ou manquantes.",
      });
  }
  // Optionnel: Valider la structure de 'preferences' plus en détail

  try {
    // --- Trouver l'utilisateur ---
    // IMPORTANT: Comment s'assurer que cette requête est légitime ?
    // Normalement, cette route devrait être protégée par un token, mais nous n'en avons pas encore
    // de final. Le plus simple ici est de faire confiance à l'userId reçu juste après
    // la vérification OTP réussie. Ajoutez des contrôles si nécessaire (ex: vérifier que
    // l'utilisateur correspondant à userId a bien isMobileVerified=true mais n'a pas encore de prefs).
    let user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Utilisateur non trouvé." });
    }
    if (!user.isMobileVerified) {
      // Sécurité : vérifier que le mobile a bien été vérifié avant
      return res
        .status(403)
        .json({
          success: false,
          error:
            "Le numéro de téléphone doit être vérifié avant de soumettre les préférences.",
        });
    }
    console.log(preferences);
    // --- Enregistrer les préférences ---
    // Assurez-vous que les clés correspondent à votre schéma Mongoose
    if (preferences.dietaryProfile) {
      user.dietaryProfile = { ...preferences.dietaryProfile };
    }
    if (preferences.healthProfile) {
      // Attention à la casse si votre modèle utilise 'healthProfile' et le schéma 'HealthProfile'
      user.healthProfile = { ...preferences.healthProfile };
    }
    // Mettre à jour d'autres champs si nécessaire (ex: un flag profileComplete?)

    console.log(`Préférences enregistrées pour l'utilisateur ${userId}`);
    const meals = await MenuItem.find();
    const prediction = 0.5;
    for (const meal of meals) {
      const dietaryInfo = meal.dietaryInfo;
      for (const [key, value] of Object.entries(dietaryInfo)) {
        if (user.dietaryProfile[key] && !value) {
          const rating = new Rating({
            userIndex: user.matrixIndex,
            menuIndex: meal.matrixIndex,
            rating: prediction,
          });
          await rating.save();
          break;
        }
        
      }
      const healthInfo = meal.healthInfo;
      for (const [key, value] of Object.entries(healthInfo)) {
        if (user.healthProfile[key] && !value) {
          const rating = new Rating({
            userIndex: user.matrixIndex,
            menuIndex: meal.matrixIndex,
            rating: prediction,
          });
          await rating.save();
          break;
        }
        if (user.recommandations.length < 10) user.recommandations.push(meal);
      }
    }

    user = await user.save();

    // --- Générer le TOKEN JWT FINAL ---
    const token = jwt.sign(
      { userId: user._id },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
    );
    console.log(`Token JWT final généré pour ${userId}`);

    // --- Renvoyer la réponse finale avec Token et User ---
    // Copiez/Adaptez la structure de l'objet 'user' renvoyé par votre 'verifyOTP' original
    // pour être cohérent avec ce que le modèle UserModel de Flutter attend.
    res.status(200).json({
      success: true,
      token: token, // Le token final !
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        mobileNumber: user.mobileNumber,
        countryCode: user.countryCode,
        profileImage: user.profileImage,
        isVerified: user.isVerified,
        isMobileVerified: user.isMobileVerified,
        isAdmin: user.isAdmin,
        isRestaurantOwner: user.isRestaurantOwner,
        addresses: user.addresses || [],
        wallet: { balance: user.wallet?.balance ?? 0 },
        favorites: user.favorites || [],
        recommandations: user.recommandations || [],
        dietaryProfile: user.dietaryProfile, // Renvoyer les profils mis à jour
        healthProfile: user.healthProfile,
        // ... autres champs nécessaires pour le modèle UserModel Flutter ...
      },
    });
  } catch (error) {
    console.error("Erreur dans submitPreferences:", error);
    next(error);
  }
};