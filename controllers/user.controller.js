import { User } from "../models/user.model.js"

import { uploadImage } from "../services/cloudinaryService.js"
import jwt from "jsonwebtoken"
import { MenuItem } from "../models/menuItem.model.js"
import { Rating } from "../models/rating.model.js"
// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
export const getUserProfile = async (req, res) => {
  console.log("Backend: /me");
  try {
    const user = req.user; // Récupérer l'utilisateur validé

    // --- Renouvellement du Token (Sliding Session) ---
    // Créer un nouveau token avec une nouvelle date d'expiration
    const refreshedToken = jwt.sign(
        { userId: user._id }, // Même payload (juste l'ID utilisateur)
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "30d" } // Nouvelle durée de vie
    );
    console.log(`Backend: Token renouvelé pour l'utilisateur ${user._id} lors de /me`);
    // --- Fin Renouvellement ---

    // Renvoyer les données utilisateur et le token rafraîchi
    // Assurez-vous que les champs correspondent à votre UserModel Flutter
    res.status(200).json({
      // Mettre le token rafraîchi dans le corps JSON (clé 'refreshedToken')
      refreshedToken: refreshedToken, // <-- NOUVEAU TOKEN ICI
      // Vous pouvez choisir de renvoyer l'objet user complet ou seulement les champs nécessaires
      // Exemple renvoyant les champs principaux (similaire à verifyOTP) :
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
      console.error("Erreur dans getMyProfile:", error);
      // Normalement, l'utilisateur est déjà trouvé, donc peu d'erreurs ici
      // sauf si la génération du token échoue (peu probable)
      next(error);
  }
}

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
export const updateUserProfile = async (req, res) => {
  try {
    const { fullName, email, profileImage } = req.body

    const user = await User.findById(req.user._id)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    if (fullName) user.fullName = fullName
    if (email) user.email = email

    // Handle profile image upload if provided as base64
    if (profileImage && profileImage.startsWith("data:image")) {
      try {
        const uploadResult = await uploadImage(profileImage, "food_delivery/profiles")
        user.profileImage = uploadResult.secure_url
      } catch (uploadError) {
        console.error("Profile image upload error:", uploadError)
        return res.status(400).json({ message: "Failed to upload profile image" })
      }
    } else if (profileImage) {
      // If it's a URL, just save it
      user.profileImage = profileImage
    }

    const updatedUser = await user.save()

    res.status(200).json({
      _id: updatedUser._id,
      fullName: updatedUser.fullName,
      email: updatedUser.email || "",
      mobileNumber: updatedUser.mobileNumber,
      profileImage: updatedUser.profileImage || "",
      isAdmin: updatedUser.isAdmin,
      isRestaurantOwner: updatedUser.isRestaurantOwner,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}

// @desc    Add user address
// @route   POST /api/users/addresses
// @access  Private
// Fichier de votre contrôleur backend (ex: addressController.js)
// Assurez-vous que le modèle User est importé et que req.user est défini par un middleware d'auth

export const addAddress = async (req, res) => {
  console.log('adding the adresse');
  try {
    // --- MODIFICATION : Lire 'label' et 'placeId' depuis le corps de la requête ---
    const {
      label,         // <-- AJOUTÉ
      type,
      address,
      apartment,
      building,
      landmark,
      latitude,
      longitude,
      isDefault,
      placeId        // <-- AJOUTÉ (sera undefined si non envoyé par le client)
    } = req.body;

    // --- MODIFICATION : Validation des champs requis ---
    // Adapter cette validation aux champs réellement requis par votre logique métier
    if (!label || !address || !type || latitude == null || longitude == null) {
       return res.status(400).json({ message: "Champs requis manquants (label, type, address, latitude, longitude)." });
    }
    // Vérifier si type est valide (optionnel, Mongoose le fait aussi)
    if (!["home", "office", "other"].includes(type)) {
        return res.status(400).json({ message: "Type d'adresse invalide." });
    }
    // ---------------------------------------------------

    // Récupérer l'ID utilisateur depuis la requête (adapté à votre middleware d'auth)
    const userId = req.user._id; // Ou req.user.id, etc.
    if (!userId) {
        return res.status(401).json({ message: "Utilisateur non authentifié." });
    }

    // Trouver l'utilisateur en base de données
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "Utilisateur non trouvé." });
    }

    // Si la nouvelle adresse est marquée comme défaut, mettre les autres à false
    // (Attention: user.addresses peut être null/undefined si jamais initialisé)
    if (isDefault === true && user.addresses && user.addresses.length > 0) {
      user.addresses.forEach((addr) => {
        if (addr.isDefault === true) { // Modifier seulement si nécessaire
             addr.isDefault = false;
        }
      });
    }

    // Créer l'objet pour la nouvelle adresse (avec les nouveaux champs)
    const newAddressObject = {
      label: label,                 // <-- AJOUTÉ
      type: type,                   // Sera 'home' par défaut si non fourni (grâce au schéma Mongoose)
      address: address,
      apartment: apartment,
      building: building,
      landmark: landmark,
      latitude: latitude,
      longitude: longitude,
      isDefault: isDefault || false, // Mongoose mettra false par défaut si non fourni
      placeId: placeId,             // <-- AJOUTÉ (sera undefined/null si non fourni)
    };

    // Ajouter la nouvelle adresse au tableau (initialiser si n'existe pas)
    if (!user.addresses) {
        user.addresses = [];
    }
    user.addresses.push(newAddressObject);

    // Sauvegarder le document utilisateur mis à jour
    const updatedUser = await user.save();

    console.log(`Adresse '${label}' ajoutée pour l'utilisateur ${userId}`);

    // --- MODIFICATION : Retourner l'utilisateur complet (Recommandé) ---
    res.status(201).json({ // 201 Created est plus sémantique pour un ajout
      message: "Adresse ajoutée avec succès",
      user: {
        _id: updatedUser._id,
        fullName:updatedUser.fullName,
        email: updatedUser.email,
        mobileNumber: updatedUser.mobileNumber,
        countryCode: updatedUser.countryCode,
        profileImage:updatedUser.profileImage,
        isVerified:updatedUser.isVerified,
        isMobileVerified:updatedUser.isMobileVerified,
        isAdmin: updatedUser.isAdmin,
        isRestaurantOwner:updatedUser.isRestaurantOwner,
        addresses: updatedUser.addresses || [],
        wallet: { balance: updatedUser.wallet?.balance ?? 0 },
        favorites: updatedUser.favorites || [],
        recommandations: updatedUser.recommandations || [],
        dietaryProfile: updatedUser.dietaryProfile, // Renvoyer les profils mis à jour
        healthProfile: updatedUser.healthProfile,
        // ... autres champs nécessaires pour le modèle UserModel Flutter ...
      }, // Retourner l'objet user complet (utiliser .toObject() ou une transformation si nécessaire pour enlever les méthodes Mongoose)
      // addresses: updatedUser.addresses // Alternative si vous ne voulez retourner que la liste
    });
    // -------------------------------------------------------------

  } catch (error) {
    console.error("Erreur lors de l'ajout d'adresse:", error);
    res.status(500).json({ message: "Erreur serveur lors de l'ajout de l'adresse." });
  }
};

// @desc    Update user address
// @route   PUT /api/users/addresses/:id
// @access  Private
export const updateAddress = async (req, res) => {
  try {
    const { type, address, apartment, building, landmark, latitude, longitude, isDefault } = req.body

    const user = await User.findById(req.user._id)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Find address by ID
    const addressToUpdate = user.addresses.id(req.params.id)

    if (!addressToUpdate) {
      return res.status(404).json({ message: "Address not found" })
    }

    // If new address is default, remove default from other addresses
    if (isDefault && !addressToUpdate.isDefault) {
      user.addresses.forEach((addr) => {
        addr.isDefault = false
      })
    }

    // Update address fields
    if (type) addressToUpdate.type = type
    if (address) addressToUpdate.address = address
    if (apartment) addressToUpdate.apartment = apartment
    if (building) addressToUpdate.building = building
    if (landmark) addressToUpdate.landmark = landmark
    if (latitude) addressToUpdate.latitude = latitude
    if (longitude) addressToUpdate.longitude = longitude
    if (isDefault !== undefined) addressToUpdate.isDefault = isDefault

    await user.save()

    res.status(200).json({
      message: "Address updated successfully",
      addresses: user.addresses,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}

// @desc    Delete user address
// @route   DELETE /api/users/addresses/:id
// @access  Private
export const deleteAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    // Find address by ID
    const addressToDelete = user.addresses.id(req.params.id)

    if (!addressToDelete) {
      return res.status(404).json({ message: "Address not found" })
    }
    // Remove address
    addressToDelete.remove()
    await user.save()
    res.status(200).json({
      message: "Address deleted successfully",
      addresses: user.addresses,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}

// @desc    Get all user addresses
// @route   GET /api/users/addresses
// @access  Private
export const getAddresses = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }
    res.status(200).json(user.addresses)
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}

// @desc    Add restaurant to favorites
// @route   POST /api/users/favorites
// @access  Private
export const addToFavorites = async (req, res) => {
  try {
    console.log('adding favorites');
    const favoriteId = req.params.id
    // Check if restaurant exists
    const user = await User.findById(req.user._id)
    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }
    
    // Check if restaurant is already in favorites
    if (user.favorites.includes(favoriteId)) {
      return res.status(400).json({ message: "Restaurant already in favorites" })
    }
    // Add to favorites
    user.favorites.push(favoriteId)
    await user.save()
    const dish= await MenuItem.findById(favoriteId);
    let rating= await Rating.findOne({userIndex:user.matrixIndex,menuIndex:dish.matrixIndex});

    if(rating){
      rating.rating=5;
    }else{
      rating=new Rating({userIndex:user.matrixIndex,menuIndex:dish.matrixIndex,rating:5});
    }
    await rating.save();
    

    res.status(200).json({
      message: "Added to favorites",
      favorites: user.favorites,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}

// @desc    Remove restaurant from favorites
// @route   DELETE /api/users/favorites/:id
// @access  Private
export const removeFromFavorites = async (req, res) => {
  try {
    console.log('removing favorites');
    const favoriteId = req.params.id
    const user = await User.findById(req.user._id)
    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }
    // Check if restaurant is in favorites
    if (!user.favorites.includes(favoriteId)) {
      return res.status(400).json({ message: "Restaurant not in favorites" })
    }
    // Remove from favorites
    user.favorites = user.favorites.filter((id) => id.toString() !== favoriteId)
    await user.save()
    res.status(200).json({
      message: "Removed from favorites",
      favorites: user.favorites,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}

// @desc    Get favorite restaurants
// @route   GET /api/users/favorites
// @access  Private
export const getFavorites = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate({
      path: "favorites",
      select: "name logo cuisines rating distance location",
    })
    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }
    res.status(200).json(user.favorites)
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}

// @desc    Logout user (clear device token)
// @route   POST /api/users/logout
// @access  Private
export const logoutUser = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }
    // Clear device token
    user.deviceToken = undefined
    await user.save()
    res.status(200).json({ message: "Logged out successfully" })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Server Error" })
  }
}
