// controllers/recommendationController.js
import { User } from '../models/userModel.js';
import { MenuItem } from '../models/menuItemModel.js';
import { Rating } from '../models/rating.model.js'; // Notre nouveau modèle
import mongoose from 'mongoose';
import tf from '@tensorflow/tfjs-node'; // TensorFlow.js pour Node.js



export const trainAndGenerateRecommendations = async (req, res) => {
  try {
    console.log("Début de l'entraînement du modèle de recommandation...");

    const allRatings = await Rating.find({})
                            .populate('user', '_id')
                            .populate('menuItem', '_id');

    if (allRatings.length < 10) { // Augmenter le seuil pour un entraînement significatif
      if (res) return res.status(200).json({ message: "Pas assez de notes pour un entraînement significatif." });
      console.log("Pas assez de notes pour un entraînement significatif.");
      return;
    }

    // 1. Calculer la note moyenne pour chaque utilisateur
    const userRatingsSum = new Map(); 
    allRatings.forEach(r => {
        if (r.user && r.user._id) {
            const userIdStr = r.user._id.toString();
            if (!userRatingsSum.has(userIdStr)) {
                userRatingsSum.set(userIdStr, { sum: 0, count: 0 });
            }
            const userData = userRatingsSum.get(userIdStr);
            userData.sum += r.rating;
            userData.count += 1;
        }
    });

    const userMeanRatings = new Map(); 
    userRatingsSum.forEach((data, userIdStr) => {
        userMeanRatings.set(userIdStr, data.count > 0 ? data.sum / data.count : 0);
    });
    console.log("Notes moyennes par utilisateur calculées.");

    // 2. Préparer les données pour TensorFlow.js (avec normalisation)
    const userToIntegerIndex = new Map();
    const itemToIntegerIndex = new Map();
    const integerIndexToUser = []; 
    const integerIndexToItem = []; 

    let nextUserIntegerIndex = 0;
    let nextItemIntegerIndex = 0;

    const usersTensorData = [];
    const itemsTensorData = [];
    const normalizedRatingsTensorData = []; 

    allRatings.forEach(r => {
      if (r.user && r.user._id && r.menuItem && r.menuItem._id) {
        const userIdStr = r.user._id.toString();
        const menuItemIdStr = r.menuItem._id.toString();
        const userMean = userMeanRatings.get(userIdStr) || 0; 

        let currentUserIntIndex = userToIntegerIndex.get(userIdStr);
        if (currentUserIntIndex === undefined) {
          currentUserIntIndex = nextUserIntegerIndex++;
          userToIntegerIndex.set(userIdStr, currentUserIntIndex);
          integerIndexToUser[currentUserIntIndex] = userIdStr;
        }

        let currentItemIntIndex = itemToIntegerIndex.get(menuItemIdStr);
        if (currentItemIntIndex === undefined) {
          currentItemIntIndex = nextItemIntegerIndex++;
          itemToIntegerIndex.set(menuItemIdStr, currentItemIntIndex);
          integerIndexToItem[currentItemIntIndex] = menuItemIdStr;
        }
        
        usersTensorData.push(currentUserIntIndex);
        itemsTensorData.push(currentItemIntIndex);
        normalizedRatingsTensorData.push(r.rating - userMean); 
      }
    });
    
    if (usersTensorData.length === 0) {
        if (res) return res.status(200).json({ message: "Données de notation valides insuffisantes après mapping." });
        console.log("Données de notation valides insuffisantes après mapping.");
        return;
    }

    const numUsers = nextUserIntegerIndex;
    const numItems = nextItemIntegerIndex;
    const embeddingDim = 10; 
    const lambda_ = 0.01; // Coefficient de régularisation L2 (à ajuster)

    const userTensor = tf.tensor1d(usersTensorData, 'int32');
    const itemTensor = tf.tensor1d(itemsTensorData, 'int32');
    const normalizedRatingTensor = tf.tensor1d(normalizedRatingsTensorData); 

    // 3. Définir et entraîner le modèle
    const userInput = tf.input({shape: [1], name: 'user_input', dtype: 'int32'});
    const itemInput = tf.input({shape: [1], name: 'item_input', dtype: 'int32'});

    const userEmbeddingLayer = tf.layers.embedding({
        inputDim: numUsers, 
        outputDim: embeddingDim, 
        inputLength: 1, 
        name: 'user_embedding',
        embeddingsRegularizer: tf.regularizers.l2({l2: lambda_}) // Régularisation L2
    });
    const itemEmbeddingLayer = tf.layers.embedding({
        inputDim: numItems, 
        outputDim: embeddingDim, 
        inputLength: 1, 
        name: 'item_embedding',
        embeddingsRegularizer: tf.regularizers.l2({l2: lambda_}) // Régularisation L2
    });

    const userVec = tf.layers.flatten().apply(userEmbeddingLayer.apply(userInput));
    const itemVec = tf.layers.flatten().apply(itemEmbeddingLayer.apply(itemInput));
    
    const dotProduct = tf.layers.dot({axes: 1}).apply([userVec, itemVec]);

    const userBiasLayer = tf.layers.embedding({
        inputDim: numUsers, 
        outputDim: 1, 
        inputLength: 1, 
        name: 'user_bias',
        embeddingsRegularizer: tf.regularizers.l2({l2: lambda_}) // Régularisation L2
    });
    const itemBiasLayer = tf.layers.embedding({
        inputDim: numItems, 
        outputDim: 1, 
        inputLength: 1, 
        name: 'item_bias',
        embeddingsRegularizer: tf.regularizers.l2({l2: lambda_}) // Régularisation L2
    });
    
    const userBiasVec = tf.layers.flatten().apply(userBiasLayer.apply(userInput));
    const itemBiasVec = tf.layers.flatten().apply(itemBiasLayer.apply(itemInput));

    let prediction = tf.layers.add().apply([dotProduct, userBiasVec, itemBiasVec]); 

    const model = tf.model({inputs: [userInput, itemInput], outputs: prediction});
    
    // La perte de régularisation est ajoutée automatiquement par TensorFlow
    // lorsque les couches ont des `embeddingsRegularizer` (ou `kernelRegularizer`, `biasRegularizer`).
    model.compile({optimizer: tf.train.adam(0.005), loss: 'meanSquaredError'});

    console.log("Résumé du modèle (prédisant des notes normalisées, avec régularisation):", model.summary());
    console.log(`Entraînement avec numUsers (mappés): ${numUsers}, numItems (mappés): ${numItems}, lambda: ${lambda_}`);

    const history = await model.fit([userTensor, itemTensor], normalizedRatingTensor, { 
      epochs: 30, 
      batchSize: 32, 
      shuffle: true,
      validationSplit: 0.1, // Optionnel: utiliser une partie des données pour la validation
      callbacks: [
          tf.callbacks.earlyStopping({monitor: 'val_loss', patience: 5, minDelta: 0.0005 }), // Monitorer val_loss
          // Vous pouvez ajouter un callback pour logger la perte de régularisation si besoin,
          // mais elle est incluse dans la 'loss' et 'val_loss' totales.
      ]
    });
    const finalLoss = history.history.loss.pop() || (history.history.loss.length > 0 ? history.history.loss[history.history.loss.length -1] : 'N/A');
    const finalValLoss = history.history.val_loss ? (history.history.val_loss.pop() || (history.history.val_loss.length > 0 ? history.history.val_loss[history.history.val_loss.length -1] : 'N/A')) : 'N/A';
    console.log(`Entraînement terminé. Perte finale: ${finalLoss}, Perte de validation finale: ${finalValLoss}`);

    // 4. Extraire les embeddings entraînés
    const userEmbeddings = userEmbeddingLayer.getWeights()[0].arraySync();
    const itemEmbeddings = itemEmbeddingLayer.getWeights()[0].arraySync();
    const userBiases = userBiasLayer.getWeights()[0].arraySync();
    const itemBiases = itemBiasLayer.getWeights()[0].arraySync();

    // 5. Mettre à jour User.cfParams et MenuItem.cfFeatures
    console.log("Début de la mise à jour des embeddings dans la DB...");
    for (let i = 0; i < numUsers; i++) {
      const userIdStr = integerIndexToUser[i];
      if (userIdStr && userEmbeddings[i] && userBiases[i]) {
        await User.findByIdAndUpdate(userIdStr, {
          $set: {
            'cfParams.w': userEmbeddings[i],
            'cfParams.b': userBiases[i][0],
            'cfParams.lastTrained': new Date(),
          }
        });
      }
    }

    for (let i = 0; i < numItems; i++) {
      const menuItemIdStr = integerIndexToItem[i];
      if (menuItemIdStr && itemEmbeddings[i] && itemBiases[i]) { 
        await MenuItem.findByIdAndUpdate(menuItemIdStr, {
          $set: {
            cfFeatures: itemEmbeddings[i]
          }
        });
      }
    }
    console.log("Embeddings et biais d'articles mis à jour dans la base de données.");

    // 6. Générer et stocker les recommandations pour chaque utilisateur
    console.log("Début de la génération des recommandations...");
    const allDbUsers = await User.find({}).select('_id favorites'); 
    const allDbMenuItems = await MenuItem.find({}).select('_id');

    for (const dbUser of allDbUsers) {
      const userIdStr = dbUser._id.toString();
      const userIntIndex = userToIntegerIndex.get(userIdStr);
      const userMean = userMeanRatings.get(userIdStr) || 0; 
      
      if (userIntIndex === undefined || !userEmbeddings[userIntIndex] || !userBiases[userIntIndex]) continue;

      const userEmbeddingVector = tf.tensor1d(userEmbeddings[userIntIndex]);
      const userBiasValue = userBiases[userIntIndex][0];
      const recommendations = [];

      const interactedItemIds = new Set();
      const userSpecificRatings = await Rating.find({ user: dbUser._id }).select('menuItem').lean();
      userSpecificRatings.forEach(r => interactedItemIds.add(r.menuItem.toString()));
      dbUser.favorites.forEach(favId => interactedItemIds.add(favId.toString()));

      for (const dbMenuItem of allDbMenuItems) {
        const menuItemIdStr = dbMenuItem._id.toString();
        const itemIntIndex = itemToIntegerIndex.get(menuItemIdStr);

        if (itemIntIndex === undefined || !itemEmbeddings[itemIntIndex] || !itemBiases[itemIntIndex] || interactedItemIds.has(menuItemIdStr)) {
          continue;
        }

        const itemEmbeddingVector = tf.tensor1d(itemEmbeddings[itemIntIndex]);
        const itemBiasValue = itemBiases[itemIntIndex][0];
        
        const dotProductPred = tf.dot(userEmbeddingVector, itemEmbeddingVector).dataSync()[0];
        const predictedNormalizedRating = dotProductPred + userBiasValue + itemBiasValue;
        const predictedOriginalScaleRating = predictedNormalizedRating + userMean; 
        
        recommendations.push({ menuItemId: dbMenuItem._id, predictedRating: predictedOriginalScaleRating });
      }

      recommendations.sort((a, b) => b.predictedRating - a.predictedRating);
      const topNRecommendations = recommendations.slice(0, 15).map(rec => rec.menuItemId);
      
      await User.findByIdAndUpdate(dbUser._id, { recommendations: topNRecommendations });
    }

    console.log("Recommandations générées et stockées pour les utilisateurs.");
    if (res) {
        res.status(200).json({ 
            message: "Modèle entraîné et recommandations générées avec succès.",
            finalLoss: finalLoss,
            finalValLoss: finalValLoss 
        });
    }
    
  } catch (error) {
    console.error("Erreur lors de l'entraînement ou de la génération des recommandations:", error);
    if (res) {
        res.status(500).json({ message: "Erreur serveur.", error: error.message });
    }
  }
};

