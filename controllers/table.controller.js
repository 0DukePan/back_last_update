import {Table} from "../models/table.model.js"
import TableSession from "../models/table-session.model.js"

// Get all tables with status
export const getAllTables = async (req, res, next) => {
  try {
    const tables = await Table.find()
      .populate({
        path: "currentSession",
        select: "startTime orders status totalAmount",
        populate: {
          path: "orders",
          select: "items totalAmount status",
        },
      })
      .sort({ createdAt: 1 })

    // Format response - removed tableNumber
    const formattedTables = tables.map((table) => ({
      id: table._id,
      qrCode: table.qrCode,
      deviceId: table.deviceId,
      status: table.status,
      isActive: table.isActive,
      currentSession: table.currentSession
        ? {
            id: table.currentSession._id,
            startTime: table.currentSession.startTime,
            orderCount: table.currentSession.orders.length,
            totalAmount: table.currentSession.totalAmount,
            status: table.currentSession.status,
          }
        : null,
    }))

    res.status(200).json({ tables: formattedTables })
  } catch (error) {
    next(error)
  }
}

// Get table details with current session
export const getTableDetails = async (req, res, next) => {
  try {
    const { tableId } = req.params
    const { locale = "en" } = req.query

    const table = await Table.findById(tableId).populate({
      path: "currentSession",
      populate: {
        path: "orders",
        populate: {
          path: "items.foodItem",
          select: "name image isVeg",
        },
      },
    })

    if (!table) {
      return res.status(404).json({ message: "Table not found" })
    }

    // Format response - removed tableNumber
    const result = {
      id: table._id,
      qrCode: table.qrCode,
      deviceId: table.deviceId,
      status: table.status,
      isActive: table.isActive,
    }

    if (table.currentSession) {
      const session = table.currentSession
      const elapsedMinutes = Math.floor((new Date() - session.startTime) / (1000 * 60))

      result.session = {
        id: session._id,
        startTime: session.startTime,
        elapsedTime: `${Math.floor(elapsedMinutes / 60)}:${(elapsedMinutes % 60).toString().padStart(2, "0")}`,
        status: session.status,
        totalAmount: session.totalAmount,
        orders: session.orders.map((order) => ({
          id: order._id,
          items: order.items.map((item) => ({
            id: item._id,
            foodItem: {
              id: item.foodItem._id,
              name: item.foodItem.name[locale] || item.foodItem.name.en || Object.values(item.foodItem.name)[0],
              image: item.foodItem.image,
              isVeg: item.foodItem.isVeg,
            },
            quantity: item.quantity,
            price: item.price,
            subtotal: item.subtotal,
          })),
          totalAmount: order.totalAmount,
          status: order.status,
        })),
      }
    }

    res.status(200).json({ table: result })
  } catch (error) {
    next(error)
  }
}

// Update table status
export const updateTableStatus = async (req, res, next) => {
  try {
    const { tableId } = req.params
    const { status } = req.body

    if (!status) {
      return res.status(400).json({ message: "Status is required" })
    }

    const table = await Table.findById(tableId)

    if (!table) {
      return res.status(404).json({ message: "Table not found" })
    }

    // If table has an active session and status is being changed to available
    if (table.currentSession && status === "available") {
      // End the current session
      await TableSession.findByIdAndUpdate(table.currentSession, {
        status: "completed",
        endTime: new Date(),
      })
      table.currentSession = null
    }

    table.status = status
    await table.save()

    res.status(200).json({
      message: "Table status updated successfully",
      table: {
        id: table._id,
        qrCode: table.qrCode,
        deviceId: table.deviceId,
        status: table.status,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Create or update table
export const createOrUpdateTable = async (req, res, next) => {
  try {
    const { tableId } = req.params
    const { qrCode, deviceId, isActive } = req.body

    if (!qrCode || !deviceId) {
      return res.status(400).json({ message: "QR code and device ID are required" })
    }

    let table
    let message

    if (tableId) {
      // Update existing table
      table = await Table.findById(tableId)

      if (!table) {
        return res.status(404).json({ message: "Table not found" })
      }

      table.qrCode = qrCode
      table.deviceId = deviceId

      if (isActive !== undefined) {
        table.isActive = isActive
      }

      message = "Table updated successfully"
    } else {
      // Create new table
      table = new Table({
        qrCode,
        deviceId,
        isActive: isActive !== undefined ? isActive : false,
      })

      message = "Table created successfully"
    }

    await table.save()

    res.status(200).json({
      message,
      table: {
        id: table._id,
        qrCode: table.qrCode,
        deviceId: table.deviceId,
        status: table.status,
        isActive: table.isActive,
      },
    })
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        message: "QR code or device ID already exists. Please use unique values.",
      })
    }
    next(error)
  }
}

// Start a new table session
export const startTableSession = async (req, res, next) => {
  try {
    const { tableId } = req.params

    const table = await Table.findById(tableId)

    if (!table) {
      return res.status(404).json({ message: "Table not found" })
    }

    if (!table.isActive) {
      return res.status(400).json({ message: "Table is not active" })
    }

    if (table.status !== "available") {
      return res.status(400).json({ message: "Table is not available" })
    }

    // Create a new session
    const session = new TableSession({
      table: tableId,
      startTime: new Date(),
    })

    await session.save()

    // Update table status and current session
    table.status = "occupied"
    table.currentSession = session._id
    await table.save()

    res.status(201).json({
      message: "Table session started successfully",
      session: {
        id: session._id,
        tableId: table._id,
        deviceId: table.deviceId,
        startTime: session.startTime,
        status: session.status,
      },
    })
  } catch (error) {
    next(error)
  }
}

// End a table session
export const endTableSession = async (req, res, next) => {
  try {
    const { sessionId } = req.params

    const session = await TableSession.findById(sessionId)

    if (!session) {
      return res.status(404).json({ message: "Session not found" })
    }

    if (session.status !== "active") {
      return res.status(400).json({ message: "Session is not active" })
    }

    // End the session
    session.status = "completed"
    session.endTime = new Date()
    await session.save()

    // Update table status
    const table = await Table.findById(session.table)
    if (table) {
      table.status = "cleaning"
      table.currentSession = null
      await table.save()
    }

    res.status(200).json({
      message: "Table session ended successfully",
      session: {
        id: session._id,
        tableId: session.table,
        endTime: session.endTime,
        status: session.status,
        totalAmount: session.totalAmount,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get table by QR code
export const getTableByQrCode = async (req, res, next) => {
  try {
    const { qrCode } = req.params

    const table = await Table.findOne({ qrCode })

    if (!table) {
      return res.status(404).json({ message: "Table not found" })
    }

    if (!table.isActive) {
      return res.status(400).json({ message: "Table is not active" })
    }

    res.status(200).json({
      table: {
        id: table._id,
        qrCode: table.qrCode,
        deviceId: table.deviceId,
        status: table.status,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get table for QR code generation
export const getTableForQRCode = async (req, res, next) => {
  try {
    const { tableId } = req.params

    // If tableId is provided, get that specific table
    if (tableId) {
      const table = await Table.findById(tableId)

      if (!table) {
        return res.status(404).json({ message: "Table not found" })
      }

      return res.status(200).json({
        table: {
          id: table._id,
          deviceId: table.deviceId,
          qrCode: table.qrCode,
          status: table.status,
          isActive: table.isActive,
        },
      })
    }

    // If no tableId is provided, return an error
    return res.status(400).json({ message: "Table ID is required" })
  } catch (error) {
    next(error)
  }
}

// Get table by device ID or MAC address
export const getTableByDeviceId = async (req, res, next) => {
  try {
    const { deviceId } = req.params

    if (!deviceId) {
      return res.status(400).json({ message: "Device ID is required" })
    }

    const table = await Table.findOne({ deviceId })

    if (!table) {
      return res.status(404).json({ message: "No table found for this device" })
    }

    res.status(200).json({
      table: {
        id: table._id,
        deviceId: table.deviceId,
        qrCode: table.qrCode,
        status: table.status,
        isActive: table.isActive,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Register device with table
export const registerDeviceWithTable = async (req, res, next) => {
  try {
    // Assuming the Kiosk app sends its generated device ID as 'tableIdFromDevice' in the request body
    const { tableIdFromDevice } = req.body;

    if (!tableIdFromDevice) {
      return res.status(400).json({ message: "tableIdFromDevice is required in the request body." });
    }

    let table = await Table.findOne({ tableId: tableIdFromDevice });
    let message = "Table already registered.";
    let httpStatus = 200;
    let newRegistration = false;

    if (!table) {
      // If table doesn't exist, create a new one
      table = new Table({
        tableId: tableIdFromDevice, // Store the unique device ID string from the kiosk
        // deviceId: tableIdFromDevice, // If you also use a separate 'deviceId' field for other purposes
        status: "available", 
        isActive: true,     
        // qrCode: tableIdFromDevice, // Simple QR, or generate a more complex one if needed
      });
      await table.save();
      message = "Table registered successfully.";
      httpStatus = 201; // HTTP 201 Created
      newRegistration = true;
      console.log(`New table registered: ${tableIdFromDevice}, DB ID: ${table._id}`);
    } else {
      // If table exists, ensure it's active (optional, based on your logic)
      if (!table.isActive) {
        table.isActive = true;
        await table.save();
        message = "Existing table was inactive and has been re-activated.";
        console.log(`Existing table re-activated: ${tableIdFromDevice}`);
      } else {
        console.log(`Table already registered and active: ${tableIdFromDevice}`);
      }
    }

    res.status(httpStatus).json({
      message,
      table: {
        id: table._id, 
        tableId: table.tableId, 
        deviceId: table.deviceId, // This might be redundant if tableId serves as the device identifier
        status: table.status,
        isActive: table.isActive,
        qrCode: table.qrCode 
      },
    });

  } catch (error) {
    if (error.code === 11000) { 
      console.warn(`Attempt to register duplicate tableId (device ID): ${req.body.tableIdFromDevice}`, error);
      // Consider finding and returning the existing table if a duplicate is attempted
      // const existingTable = await Table.findOne({ tableId: req.body.tableIdFromDevice });
      return res.status(409).json({
        message: "Conflict: This device ID is already registered.",
        // existingTableId: existingTable ? existingTable._id : null 
      });
    }
    console.error("Error in registerDeviceWithTable:", error);
    next(error);
  }
};
