import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  updateDoc,
  collection,
  getDocs,
  addDoc,
  serverTimestamp,
  writeBatch,
  query,
  limit,
  where,
  Timestamp,
  DocumentData,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { db, auth } from "./firebase";
import { onAuthStateChanged, getAuth } from "firebase/auth";
import { debounce, throttle } from "lodash";
// These imports are dynamically loaded at runtime
// We're just declaring the types here for TypeScript
declare const Blockly: any;

// Constants for caching and throttling
const CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes cache expiry
const USER_STATUS_DEBOUNCE = 30 * 1000; // 30 seconds debounce for user status updates
const USER_COUNT_UPDATE_INTERVAL = 60 * 1000; // Update user count once per minute
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 5000; // 5 seconds

// Caches to reduce Firestore reads
interface CacheEntry {
  data: any;
  timestamp: number;
}
const roomDataCache = new Map<string, CacheEntry>();
const roomUsersCache = new Map<string, CacheEntry>();
const userRoomsCache = new Map<string, CacheEntry>();

// Check if cache is valid
const isCacheValid = (entry: CacheEntry | undefined): boolean => {
  if (!entry) return false;
  return Date.now() - entry.timestamp < CACHE_EXPIRY;
};

// Clear cache for a specific room
export function clearRoomCache(roomId: string) {
  roomDataCache.delete(roomId);
  roomUsersCache.delete(roomId);
}

// Get room data with caching to reduce Firestore reads
export async function getCachedRoomData(roomId: string) {
  const cachedData = roomDataCache.get(roomId);
  if (cachedData && isCacheValid(cachedData)) {
    console.log("Using cached room data for", roomId);
    return cachedData.data;
  }

  try {
    console.log("Fetching room data from Firestore for", roomId);
    const roomRef = doc(db, "rooms", roomId);
    const roomSnap = await getDoc(roomRef);

    if (roomSnap.exists()) {
      const roomData = roomSnap.data();
      // Cache the room data
      roomDataCache.set(roomId, {
        data: roomData,
        timestamp: Date.now(),
      });
      return roomData;
    } else {
      console.warn("Room not found:", roomId);
      return null;
    }
  } catch (error) {
    console.error("Error getting room data:", error);
    return null;
  }
}

// Get room users with caching
export async function getRoomUsers(roomId: string) {
  const cachedUsers = roomUsersCache.get(roomId);
  if (cachedUsers && isCacheValid(cachedUsers)) {
    console.log("Using cached room users for", roomId);
    return cachedUsers.data;
  }

  try {
    console.log("Fetching room users from Firestore for", roomId);

    // Get room document first to check if it exists
    const roomRef = doc(db, "rooms", roomId);
    const roomDoc = await getDoc(roomRef);

    if (!roomDoc.exists()) {
      console.log("Room not found");
      return [];
    }

    // Get userIds from the room document
    const roomData = roomDoc.data();
    const userIds = roomData?.userIds || [];

    if (userIds.length === 0) {
      return [];
    }

    // Get user details from the subcollection
    const usersCollectionRef = collection(db, "rooms", roomId, "users");
    const usersSnapshot = await getDocs(usersCollectionRef);

    const users = usersSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Cache the results
    roomUsersCache.set(roomId, {
      data: users,
      timestamp: Date.now(),
    });

    return users;
  } catch (error) {
    console.error("Error getting room users:", error);
    return [];
  }
}

// Add room to user history with batched write
export async function addRoomToUserHistory(
  userId: string,
  roomId: string,
  roomName: string
) {
  try {
    // Create a batch to combine operations
    const batch = writeBatch(db);

    // User's room reference
    const userRoomRef = doc(db, "users", userId, "rooms", roomId);

    // Add room to user's room history
    batch.set(userRoomRef, {
      roomId,
      roomName,
      lastAccessed: serverTimestamp(),
      joinedAt: serverTimestamp(),
    });

    // Commit the batch
    await batch.commit();

    // Clear any related cache
    userRoomsCache.delete(userId);

    return true;
  } catch (error) {
    console.error("Error adding room to user history:", error);
    return false;
  }
}

// Throttled function to update user activity in room
// Only updates every 30 seconds to reduce write operations
const updateUserRoomActivityThrottled = throttle(
  async (userId: string, roomId: string) => {
    try {
      // Only update if the user is still connected
      const user = auth.currentUser;
      if (!user || user.uid !== userId) return;

      const userRoomRef = doc(db, "users", userId, "rooms", roomId);
      await updateDoc(userRoomRef, {
        lastAccessed: serverTimestamp(),
      });
    } catch (error) {
      console.error("Error updating user room activity:", error);
    }
  },
  30000
); // Throttle to once every 30 seconds

// Get user rooms with caching
export async function getUserRooms(userId: string) {
  try {
    // First check if the user has a cache invalidation marker
    const userRef = doc(db, "users", userId);
    const userDoc = await getDoc(userRef);

    if (userDoc.exists()) {
      const userData = userDoc.data();
      const cacheInvalidatedAt = userData?.cacheInvalidatedAt;

      // If we have a cached entry, check if it needs to be invalidated
      const cachedRooms = userRoomsCache.get(userId);
      if (cachedRooms && cacheInvalidatedAt) {
        // Convert Firestore timestamp to milliseconds for comparison
        const invalidationTime =
          cacheInvalidatedAt instanceof Timestamp
            ? cacheInvalidatedAt.toMillis()
            : cacheInvalidatedAt?.seconds
            ? cacheInvalidatedAt.seconds * 1000
            : 0;

        // If cache was created before invalidation, clear it
        if (invalidationTime > cachedRooms.timestamp) {
          console.log(
            "Cache invalidated, clearing user rooms cache for",
            userId
          );
          userRoomsCache.delete(userId);
        }
      }
    }

    // Check cache after potential invalidation check
    const cachedRooms = userRoomsCache.get(userId);
    if (cachedRooms && isCacheValid(cachedRooms)) {
      console.log("Using cached user rooms for", userId);
      return cachedRooms.data;
    }

    console.log("Fetching user rooms from Firestore for", userId);
    const roomsRef = collection(db, "users", userId, "rooms");
    const roomsQuery = query(roomsRef);
    const querySnapshot = await getDocs(roomsQuery);

    const rooms: any[] = [];
    querySnapshot.forEach((doc) => {
      rooms.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    // Cache the results
    userRoomsCache.set(userId, {
      data: rooms,
      timestamp: Date.now(),
    });

    return rooms;
  } catch (error) {
    console.error("Error getting user rooms:", error);
    return [];
  }
}

// Create a new room with optimized batched writes
export async function createNewRoom(
  roomName: string,
  userId: string
): Promise<string> {
  if (!userId) {
    console.error("User ID is required to create a room");
    throw new Error("User ID is required");
  }

  try {
    // Generate a unique room ID using timestamp and random string
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 10);
    const roomId = `room_${timestamp}_${randomSuffix}`;

    // Create a batch for multiple operations
    const batch = writeBatch(db);

    // Create the room document with userIds array instead of users array
    const roomRef = doc(db, "rooms", roomId);
    batch.set(roomRef, {
      roomId,
      name: roomName,
      createdBy: userId,
      createdAt: serverTimestamp(),
      lastActivity: serverTimestamp(),
      userIds: [userId], // Array of user IDs currently in the room
      isActive: true,
    });

    // Add user details to the room's users subcollection
    const userRef = doc(db, "rooms", roomId, "users", userId);
    batch.set(userRef, {
      id: userId,
      joinedAt: serverTimestamp(),
      lastActive: serverTimestamp(),
      isCreator: true,
    });

    // Also add room to user's rooms collection
    const userRoomRef = doc(db, "users", userId, "rooms", roomId);
    batch.set(userRoomRef, {
      roomId,
      name: roomName,
      joinedAt: serverTimestamp(),
      lastVisited: serverTimestamp(),
      isCreator: true,
    });

    // Execute all operations as a batch
    await batch.commit();

    // Clear any cached room data
    clearRoomCache(roomId);

    // Also clear the user's rooms cache so they immediately see the new room
    userRoomsCache.delete(userId);

    return roomId;
  } catch (error) {
    console.error("Error creating new room:", error);
    throw error;
  }
}

// Set up collaboration in the workspace with per-block synchronization
export function setupBlocklySync(
  workspace: any,
  ydoc: Y.Doc,
  options?: { blockly: any }
) {
  // Get the Blockly instance from options - make sure we access it safely
  const Blockly = options?.blockly;
  if (!Blockly) {
    console.error("Blockly is required for setupBlocklySync");
    return () => {};
  }

  console.log("Setting up per-block synchronization");

  // Create shared data structures
  const sharedBlocks = ydoc.getMap("blocks");
  const sharedBlocksData = ydoc.getMap("blocksData");
  const sharedConnections = ydoc.getMap("connections");
  const sharedWorkspaceState = ydoc.getMap("workspaceState");

  // Track local changes to avoid loops
  let isApplyingRemoteChanges = false;
  let ignoreLocalEvents = false;

  // Helper to get normalized workspace coordinates regardless of screen size
  const getNormalizedCoordinates = (block: any) => {
    const xy = block.getRelativeToSurfaceXY();

    // We store the absolute workspace coordinates which are independent
    // of screen size and current viewport
    return {
      x: xy.x,
      y: xy.y,
    };
  };

  // Helper to serialize a block to a simple object
  const serializeBlock = (block: any) => {
    if (!block) return null;

    try {
      // Get normalized block position
      const position = getNormalizedCoordinates(block);

      // Get basic block data
      const blockData: any = {
        id: block.id,
        type: block.type,
        x: position.x,
        y: position.y,
        fields: {},
        inputs: {},
        collapsed: block.isCollapsed(),
        disabled: block.disabled,
        deletable: block.isDeletable(),
        movable: block.isMovable(),
        editable: block.isEditable(),
      };

      // Get field values
      if (block.inputList) {
        block.inputList.forEach((input: any) => {
          if (input.fieldRow) {
            input.fieldRow.forEach((field: any) => {
              if (field.name && field.getValue) {
                blockData.fields[field.name] = field.getValue();
              }
            });
          }
        });
      }

      // Handle connections
      if (block.previousConnection) {
        const targetBlock = block.previousConnection.targetBlock();
        if (targetBlock) {
          blockData.previousConnection = targetBlock.id;
        }
      }

      if (block.nextConnection) {
        const targetBlock = block.nextConnection.targetBlock();
        if (targetBlock) {
          blockData.nextConnection = targetBlock.id;
        }
      }

      // Handle input connections
      if (block.inputList) {
        block.inputList.forEach((input: any) => {
          if (input.connection && input.connection.targetBlock()) {
            blockData.inputs[input.name] = input.connection.targetBlock().id;
          }
        });
      }

      return blockData;
    } catch (error) {
      console.error("Error serializing block:", error);
      return null;
    }
  };

  // Helper to create a block from serialized data
  const deserializeBlock = (blockData: any) => {
    if (!blockData || !workspace) return null;

    try {
      // Check if block already exists
      let block = workspace.getBlockById(blockData.id);

      // If block doesn't exist, create it
      if (!block) {
        block = workspace.newBlock(blockData.type, blockData.id);
        block.initSvg();
        block.render();
      }

      // Get current position
      const currentPosition = block.getRelativeToSurfaceXY();

      // Only move if position has actually changed
      // This prevents blocks from jumping back and forth when edited from different screens
      // Each user should control their own view independently
      const distanceX = Math.abs(blockData.x - currentPosition.x);
      const distanceY = Math.abs(blockData.y - currentPosition.y);

      // Increase movement threshold to prevent micro-adjustments
      if (distanceX > 5 || distanceY > 5) {
        // Move by the difference between current and desired position
        block.moveBy(
          blockData.x - currentPosition.x,
          blockData.y - currentPosition.y
        );
      }

      // Set fields
      for (const fieldName in blockData.fields) {
        const field = block.getField(fieldName);
        if (field && typeof field.setValue === "function") {
          field.setValue(blockData.fields[fieldName]);
        }
      }

      // Update block properties
      if (
        blockData.collapsed !== undefined &&
        typeof block.setCollapsed === "function"
      ) {
        block.setCollapsed(blockData.collapsed);
      }

      if (blockData.disabled !== undefined) {
        block.setDisabled(blockData.disabled);
      }

      if (
        blockData.deletable !== undefined &&
        typeof block.setDeletable === "function"
      ) {
        block.setDeletable(blockData.deletable);
      }

      if (
        blockData.movable !== undefined &&
        typeof block.setMovable === "function"
      ) {
        block.setMovable(blockData.movable);
      }

      if (
        blockData.editable !== undefined &&
        typeof block.setEditable === "function"
      ) {
        block.setEditable(blockData.editable);
      }

      return block;
    } catch (error) {
      console.error("Error deserializing block:", error, blockData);
      return null;
    }
  };

  // Helper to connect blocks based on stored connection data
  const connectBlocks = () => {
    try {
      sharedConnections.forEach((connections: any, blockId: string) => {
        const block = workspace.getBlockById(blockId);
        if (!block) return;

        // Previous connection
        if (connections.previous) {
          const targetBlock = workspace.getBlockById(connections.previous);
          if (
            targetBlock &&
            block.previousConnection &&
            targetBlock.nextConnection
          ) {
            if (!block.previousConnection.isConnected()) {
              block.previousConnection.connect(targetBlock.nextConnection);
            }
          }
        }

        // Next connection
        if (connections.next) {
          const targetBlock = workspace.getBlockById(connections.next);
          if (
            targetBlock &&
            block.nextConnection &&
            targetBlock.previousConnection
          ) {
            if (!block.nextConnection.isConnected()) {
              block.nextConnection.connect(targetBlock.previousConnection);
            }
          }
        }

        // Input connections
        if (connections.inputs) {
          for (const inputName in connections.inputs) {
            const targetId = connections.inputs[inputName];
            const target = workspace.getBlockById(targetId);
            const input = block.getInput(inputName);

            if (target && input && input.connection) {
              if (!input.connection.isConnected()) {
                input.connection.connect(
                  target.outputConnection || target.previousConnection
                );
              }
            }
          }
        }
      });
    } catch (error) {
      console.error("Error connecting blocks:", error);
    }
  };

  // Sync the entire workspace initially or when needed
  const syncFullWorkspace = () => {
    if (isApplyingRemoteChanges) return;
    isApplyingRemoteChanges = true;
    ignoreLocalEvents = true;

    try {
      // Get all blocks
      const blocks = workspace.getAllBlocks(false);

      // First pass: store block data
      blocks.forEach((block: any) => {
        const blockData = serializeBlock(block);
        if (blockData) {
          sharedBlocks.set(block.id, true);
          sharedBlocksData.set(block.id, blockData);
        }
      });

      // Second pass: store connections
      blocks.forEach((block: any) => {
        const connections: any = { inputs: {} };

        // Previous connection
        if (
          block.previousConnection &&
          block.previousConnection.targetBlock()
        ) {
          connections.previous = block.previousConnection.targetBlock().id;
        }

        // Next connection
        if (block.nextConnection && block.nextConnection.targetBlock()) {
          connections.next = block.nextConnection.targetBlock().id;
        }

        // Input connections
        if (block.inputList) {
          block.inputList.forEach((input: any) => {
            if (input.connection && input.connection.targetBlock()) {
              connections.inputs[input.name] =
                input.connection.targetBlock().id;
            }
          });
        }

        sharedConnections.set(block.id, connections);
      });

      // Store workspace state (viewport, etc.)
      const metrics = workspace.getMetrics();
      if (metrics) {
        // Store viewport information in a normalized way
        // sharedWorkspaceState.set('viewportLeft', metrics.viewLeft);
        // sharedWorkspaceState.set('viewportTop', metrics.viewTop);
        // sharedWorkspaceState.set('scale', workspace.scale);
      }

      console.log("Synchronized full workspace with", blocks.length, "blocks");
    } catch (error) {
      console.error("Error syncing full workspace:", error);
    } finally {
      isApplyingRemoteChanges = false;
      // Small delay before re-enabling event handling
      setTimeout(() => {
        ignoreLocalEvents = false;
      }, 200);
    }
  };

  // Apply remote changes to the workspace
  const applyRemoteChanges = () => {
    if (isApplyingRemoteChanges) return;
    isApplyingRemoteChanges = true;

    try {
      // Disable events temporarily
      Blockly.Events.disable();
      ignoreLocalEvents = true;
      workspace.setResizesEnabled(false);

      // Clear workspace
      workspace.clear();

      // Create all blocks first
      const blockIds = Array.from(sharedBlocksData.keys());
      blockIds.forEach((blockId) => {
        const blockData = sharedBlocksData.get(blockId);
        if (blockData) {
          deserializeBlock(blockData);
        }
      });

      // Then connect blocks
      connectBlocks();

      // Apply workspace state
      // const viewportLeft = sharedWorkspaceState.get('viewportLeft');
      // const viewportTop = sharedWorkspaceState.get('viewportTop');
      // const scale = sharedWorkspaceState.get('scale');

      // if (viewportLeft !== undefined && viewportTop !== undefined) {
      //   workspace.scroll(viewportLeft, viewportTop);
      // }

      // if (scale !== undefined && typeof workspace.setScale === 'function') {
      //   workspace.setScale(scale);
      // }

      console.log("Applied remote changes with", blockIds.length, "blocks");
    } catch (error) {
      console.error("Error applying remote changes:", error);
    } finally {
      // Re-enable events
      workspace.setResizesEnabled(true);
      Blockly.Events.enable();
      isApplyingRemoteChanges = false;
      // Small delay before re-enabling event handling
      setTimeout(() => {
        ignoreLocalEvents = false;
      }, 200);
    }
  };

  // Initialize workspace if shared data is empty
  if (sharedBlocks.size === 0) {
    console.log("Initializing shared workspace data");
    syncFullWorkspace();
  } else {
    console.log("Applying existing shared workspace data");
    applyRemoteChanges();
  }

  // Listen for changes to the workspace
  const changeListener = (event: any) => {
    // Skip if we're applying remote changes or event is NULL
    if (isApplyingRemoteChanges || ignoreLocalEvents || !event) return;

    try {
      // Handle different event types
      if (event.type === Blockly.Events.BLOCK_CREATE) {
        // New block created
        const block = workspace.getBlockById(event.blockId);
        if (block) {
          // Skip if this is a temporary/shadow block or if it's still being dragged
          // This prevents ghost blocks from appearing on other users' screens during drag operations
          if (
            block.isInFlyout ||
            block.isShadow() ||
            block.isDragging_ ||
            block.isTemporary
          ) {
            return;
          }

          // Add a small delay to avoid synchronizing blocks that are still being manipulated
          setTimeout(() => {
            if (!workspace.getBlockById(event.blockId)) return; // Block may have been deleted

            // Add to shared data
            const blockData = serializeBlock(block);
            if (blockData) {
              sharedBlocks.set(block.id, true);
              sharedBlocksData.set(block.id, blockData);

              // Add connection data
              const connections = { inputs: {} };
              sharedConnections.set(block.id, connections);
            }
          }, 300); // Slightly longer delay to ensure stability
        }
      } else if (event.type === Blockly.Events.BLOCK_DELETE) {
        // Block deleted
        sharedBlocks.delete(event.blockId);
        sharedBlocksData.delete(event.blockId);
        sharedConnections.delete(event.blockId);
      } else if (event.type === Blockly.Events.BLOCK_CHANGE) {
        // Block changed (field value, etc.)
        const block = workspace.getBlockById(event.blockId);
        if (block) {
          // Skip temporary blocks, shadow blocks, or blocks being dragged
          if (
            block.isInFlyout ||
            block.isShadow() ||
            block.isDragging_ ||
            block.isTemporary
          ) {
            return;
          }

          // Add a small delay for stability
          setTimeout(() => {
            if (!workspace.getBlockById(event.blockId)) return;

            const blockData = serializeBlock(block);
            if (blockData) {
              sharedBlocksData.set(block.id, blockData);
            }
          }, 200);
        }
      } else if (event.type === Blockly.Events.BLOCK_MOVE) {
        // Block moved or connection changed
        const block = workspace.getBlockById(event.blockId);
        if (block) {
          // Skip temporary blocks, shadow blocks, or blocks that are in the middle of being dragged
          // This ensures we only synchronize the final position after the drag operation
          if (
            block.isInFlyout ||
            block.isShadow() ||
            block.isDragging_ ||
            block.isTemporary
          ) {
            return;
          }

          // Add a delay to avoid synchronizing blocks that are still being moved
          // This ensures we only synchronize the final position after the drag operation
          setTimeout(() => {
            if (!workspace.getBlockById(event.blockId)) return; // Block may have been deleted

            // Update block data (position)
            const blockData = serializeBlock(block);
            if (blockData) {
              sharedBlocksData.set(block.id, blockData);
            }

            // Update connections
            const connections: any = { inputs: {} };

            // Previous connection
            if (
              block.previousConnection &&
              block.previousConnection.targetBlock()
            ) {
              connections.previous = block.previousConnection.targetBlock().id;
            }

            // Next connection
            if (block.nextConnection && block.nextConnection.targetBlock()) {
              connections.next = block.nextConnection.targetBlock().id;
            }

            // Input connections
            if (block.inputList) {
              block.inputList.forEach((input: any) => {
                if (input.connection && input.connection.targetBlock()) {
                  connections.inputs[input.name] =
                    input.connection.targetBlock().id;
                }
              });
            }

            sharedConnections.set(block.id, connections);
          }, 300); // Longer delay for move events
        }
      } else if (event.type === Blockly.Events.VIEWPORT_CHANGE) {
        // Viewport changed (scroll, zoom)
        // Skip synchronizing viewport changes from local user
        // This prevents the view from jumping when multiple users are viewing different areas
        // Each user should control their own view independently
        // Previous implementation that was causing the glitching:
        // const viewportLeft = sharedWorkspaceState.get('viewportLeft');
        // const viewportTop = sharedWorkspaceState.get('viewportTop');
        // const scale = sharedWorkspaceState.get('scale');
        // // Only update if values are valid
        // if (viewportLeft !== undefined && viewportTop !== undefined) {
        //   workspace.scroll(viewportLeft, viewportTop);
        // }
        // if (scale !== undefined && typeof workspace.setScale === 'function') {
        //   workspace.setScale(scale);
        // }
      }
    } catch (error) {
      console.error("Error in change listener:", error);
    }
  };

  // Listen for workspace changes
  workspace.addChangeListener(changeListener);

  // Handle updates from other clients
  const blocksObserver = (events: Y.YMapEvent<any>) => {
    if (isApplyingRemoteChanges) return;

    try {
      // Get changed keys
      const keys = events.keysChanged;
      if (keys.size === 0) return;

      // Check if block was added or removed
      const addedBlocks = Array.from(keys).filter(
        (id) => sharedBlocks.has(id) && !workspace.getBlockById(id)
      );
      const removedBlocks = Array.from(keys).filter(
        (id) => !sharedBlocks.has(id) && workspace.getBlockById(id)
      );

      // Handle case where many blocks changed at once (potential full update)
      if (keys.size > 3) {
        applyRemoteChanges();
        return;
      }

      // Handle removed blocks
      removedBlocks.forEach((id) => {
        const block = workspace.getBlockById(id);
        if (block) {
          isApplyingRemoteChanges = true;
          ignoreLocalEvents = true;
          try {
            block.dispose(false);
          } finally {
            isApplyingRemoteChanges = false;
            ignoreLocalEvents = false;
          }
        }
      });

      // Handle added blocks
      if (addedBlocks.length > 0) {
        // If we have new blocks, process a full update to ensure proper connections
        applyRemoteChanges();
      }
    } catch (error) {
      console.error("Error handling blocks updates:", error);
    }
  };

  // Observer for block data changes
  const blocksDataObserver = (events: Y.YMapEvent<any>) => {
    if (isApplyingRemoteChanges) return;

    try {
      // Get changed keys
      const keys = events.keysChanged;
      if (keys.size === 0) return;

      // Process each changed block that already exists
      isApplyingRemoteChanges = true;
      ignoreLocalEvents = true;

      try {
        Array.from(keys).forEach((id) => {
          const blockData = sharedBlocksData.get(id);
          if (blockData) {
            deserializeBlock(blockData);
          }
        });

        // Update connections after all blocks are updated
        connectBlocks();
      } finally {
        isApplyingRemoteChanges = false;
        // Small delay before re-enabling event handling
        setTimeout(() => {
          ignoreLocalEvents = false;
        }, 200);
      }
    } catch (error) {
      console.error("Error handling block data updates:", error);
    }
  };

  // Observer for workspace state changes
  const workspaceStateObserver = (events: Y.YMapEvent<any>) => {
    if (isApplyingRemoteChanges) return;

    try {
      // Check if viewport changed
      if (
        events.keysChanged.has("viewportLeft") ||
        events.keysChanged.has("viewportTop") ||
        events.keysChanged.has("scale")
      ) {
        // Viewport synchronization is disabled to prevent jumping views
        // Each user can navigate their workspace independently
        // Previous implementation that was causing the glitching:
        // const viewportLeft = sharedWorkspaceState.get('viewportLeft');
        // const viewportTop = sharedWorkspaceState.get('viewportTop');
        // const scale = sharedWorkspaceState.get('scale');
        // // Only update if values are valid
        // if (viewportLeft !== undefined && viewportTop !== undefined) {
        //   workspace.scroll(viewportLeft, viewportTop);
        // }
        // if (scale !== undefined && typeof workspace.setScale === 'function') {
        //   workspace.setScale(scale);
        // }
      }
    } catch (error) {
      console.error("Error handling workspace state updates:", error);
    }
  };

  // Set up observers
  sharedBlocks.observe(blocksObserver);
  sharedBlocksData.observe(blocksDataObserver);
  sharedWorkspaceState.observe(workspaceStateObserver);

  // Return cleanup function
  return () => {
    // Remove change listener
    workspace.removeChangeListener(changeListener);

    // Disconnect observers
    sharedBlocks.unobserve(blocksObserver);
    sharedBlocksData.unobserve(blocksDataObserver);
    sharedWorkspaceState.unobserve(workspaceStateObserver);
  };
}

// Set up cursor tracking between users
export function setupCursorTracking(
  workspace: any,
  ydoc: Y.Doc,
  provider: any,
  user: any
) {
  if (!workspace || !ydoc || !provider) {
    console.warn("Missing required parameters for cursor tracking");
    return () => {};
  }

  console.log("Setting up cursor tracking with user:", user);

  // Map to store cursor elements for each user
  const cursors = new Map();

  // Create a room status element to show who's in the room
  const createRoomStatusElement = () => {
    const statusDiv = document.createElement("div");
    statusDiv.id = "blockly-room-status";
    statusDiv.style.position = "absolute";
    statusDiv.style.top = "8px";
    statusDiv.style.right = "8px";
    statusDiv.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
    statusDiv.style.color = "white";
    statusDiv.style.padding = "8px 12px";
    statusDiv.style.borderRadius = "4px";
    statusDiv.style.zIndex = "1000";
    statusDiv.style.maxWidth = "300px";
    statusDiv.style.boxShadow = "0 2px 5px rgba(0,0,0,0.2)";
    statusDiv.style.fontSize = "12px";
    statusDiv.style.fontWeight = "bold";
    statusDiv.style.whiteSpace = "nowrap";
    statusDiv.innerHTML =
      '<div>Connected users:</div><div id="blockly-user-list"></div>';

    // Append to workspace container
    const injectionDiv = workspace.getInjectionDiv();
    if (injectionDiv) {
      injectionDiv.appendChild(statusDiv);
    } else {
      document.body.appendChild(statusDiv);
    }

    return statusDiv;
  };

  // Create the status element
  const statusElement = createRoomStatusElement();

  // Update the user list in the room status display
  const updateUserList = () => {
    // Find the user list element in the status bar
    const userListEl = document.getElementById("blockly-user-list");
    if (!userListEl) return;

    // Clear current list
    userListEl.innerHTML = "";

    // Get current users from awareness
    const states = provider.awareness.getStates();
    const currentClientId = provider.awareness.clientID;

    // Create user array manually to avoid TypeScript errors with Array.from
    const users: {
      clientId: number;
      name: string;
      color: string;
      isCurrentUser: boolean;
    }[] = [];

    // Manually iterate through the Map entries
    states.forEach((state: any, clientId: number) => {
      users.push({
        clientId,
        name: state.name || "Anonymous",
        color: state.color || "#cccccc",
        isCurrentUser: clientId === currentClientId,
      });
    });

    // Sort the users
    users.sort((a, b) => {
      // Current user always first
      if (a.isCurrentUser) return -1;
      if (b.isCurrentUser) return 1;
      // Then sort by name
      return a.name.localeCompare(b.name);
    });

    // Add users to the list
    users.forEach((user) => {
      const userEl = document.createElement("div");
      userEl.style.display = "flex";
      userEl.style.alignItems = "center";
      userEl.style.marginTop = "4px";

      // Add color dot
      const colorDot = document.createElement("span");
      colorDot.style.display = "inline-block";
      colorDot.style.width = "10px";
      colorDot.style.height = "10px";
      colorDot.style.backgroundColor = user.color;
      colorDot.style.borderRadius = "50%";
      colorDot.style.marginRight = "6px";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = user.name + (user.isCurrentUser ? " (you)" : "");
      nameSpan.style.fontWeight = user.isCurrentUser ? "bold" : "normal";

      userEl.appendChild(colorDot);
      userEl.appendChild(nameSpan);
      userListEl.appendChild(userEl);
    });

    // Update the count
    const countEl = statusElement.querySelector("div:first-child");
    if (countEl) {
      countEl.textContent = `Connected users (${users.length}):`;
    }
  };

  // Set local user information if provided
  if (user && provider.awareness) {
    const localState = provider.awareness.getLocalState() || {};
    console.log("Setting local awareness state for cursor tracking", user);

    // Ensure we have a valid color
    const userColor = user.color || getRandomColor();

    provider.awareness.setLocalState({
      ...localState,
      name: user.name || localState.name || "Anonymous",
      color: userColor,
      // Initialize with current cursor position to make it visible immediately
      cursor: { x: 0, y: 0 },
    });
  }

  // Create and add a cursor element for a user
  const createCursor = (
    clientId: number,
    state: {
      name?: string;
      color?: string;
      cursor?: { x: number; y: number };
      email?: string;
    }
  ) => {
    // Don't create cursor for current user
    if (clientId === provider.awareness.clientID) return;

    console.log(
      `Creating cursor for user ${state.name || "Unknown"} (${clientId})`,
      state
    );

    // Remove existing cursor if any
    removeCursor(clientId);

    if (!state.cursor) {
      console.warn(`User ${clientId} has no cursor position`);
      return;
    }

    try {
      // Get Blockly container div
      const injectionDiv = workspace.getInjectionDiv();
      if (!injectionDiv) {
        console.error("Could not find Blockly injection div");
        return;
      }

      // Find SVG Element with a more comprehensive approach
      const findSvgElement = (): SVGSVGElement | HTMLElement | null => {
        // Try different SVG selectors in order of preference
        const selectors = [
          "svg.blocklyBlockCanvas",
          "svg.blocklySvg",
          "g.blocklyBlockCanvas",
          ".blocklyMain svg",
          ".blocklyBlockCanvas",
          "svg",
        ];

        for (const selector of selectors) {
          const element = injectionDiv.querySelector(selector);
          if (element) {
            console.log(`Found SVG element using selector: ${selector}`);
            return element;
          }
        }

        console.warn("No suitable SVG element found in Blockly workspace");
        return injectionDiv; // Fall back to the injection div
      };

      // Get SVG container using our robust finder
      const svgContainer = findSvgElement();

      if (!svgContainer) {
        console.error("Failed to find any suitable container for cursor");
        return;
      }

      console.log(
        "Found container for cursor:",
        svgContainer.tagName,
        svgContainer.className
      );

      // Create SVG cursor element for workspace-relative positioning
      const cursorGroup = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g"
      );
      cursorGroup.classList.add("blockly-cursor-svg");
      cursorGroup.setAttribute("cursor-for-client", clientId.toString());

      // Create cursor pointer SVG shape
      const cursorPath = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path"
      );
      cursorPath.setAttribute("d", "M0,0 L0,16 L12,0 Z");
      cursorPath.setAttribute("fill", state.color || "#ff0000");
      cursorPath.setAttribute("stroke", "white");
      cursorPath.setAttribute("stroke-width", "1");

      // Add cursor to group
      cursorGroup.appendChild(cursorPath);

      // Create text label for the cursor
      const textLabel = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text"
      );
      textLabel.setAttribute("x", "16");
      textLabel.setAttribute("y", "0");
      textLabel.setAttribute("fill", "white");
      textLabel.setAttribute("stroke", state.color || "#ff0000");
      textLabel.setAttribute("stroke-width", "1");
      textLabel.setAttribute("paint-order", "stroke");
      textLabel.setAttribute("font-size", "12px");
      textLabel.setAttribute("font-weight", "bold");
      textLabel.setAttribute("whiteSpace", "nowrap");
      textLabel.setAttribute("boxShadow", "0 0 5px rgba(0,0,0,0.3)");
      textLabel.textContent = state.name || "User";

      // Add background rectangle for the text
      const textBg = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect"
      );
      textBg.setAttribute("x", "12");
      textBg.setAttribute("y", "-15");
      textBg.setAttribute("width", `${(state.name?.length || 4) * 7 + 10}px`);
      textBg.setAttribute("height", "18px");
      textBg.setAttribute("fill", state.color || "#ff0000");
      textBg.setAttribute("rx", "4");
      textBg.setAttribute("ry", "4");

      // Add label elements to group (background first so text is on top)
      cursorGroup.appendChild(textBg);
      cursorGroup.appendChild(textLabel);

      // If we found an SVG element, add the cursor to it for workspace-relative positioning
      if (svgContainer instanceof SVGElement) {
        // Try to find the blockly root group to add cursor to
        const blocklyRoot =
          svgContainer.querySelector("g.blocklyBlockCanvas") ||
          svgContainer.querySelector("g.blocklyWorkspace") ||
          svgContainer;

        if (blocklyRoot && "appendChild" in blocklyRoot) {
          blocklyRoot.appendChild(cursorGroup);
        } else {
          svgContainer.appendChild(cursorGroup);
        }

        // Store cursor reference
        cursors.set(clientId, {
          element: cursorGroup,
          state,
          isSvgCursor: true,
        });
      } else {
        // Fallback to div-based cursor for non-SVG containers
        const cursorEl = document.createElement("div");
        cursorEl.className = "blockly-cursor";
        cursorEl.style.position = "absolute";
        cursorEl.style.width = "0";
        cursorEl.style.height = "0";
        cursorEl.style.zIndex = "1000";
        cursorEl.style.pointerEvents = "none";
        cursorEl.style.transition =
          "transform 0.1s ease-out, left 0.1s ease-out, top 0.1s ease-out";

        // Create cursor arrow shape using CSS borders
        cursorEl.style.borderStyle = "solid";
        cursorEl.style.borderWidth = "0 0 16px 12px";
        cursorEl.style.borderColor =
          "transparent transparent transparent " + (state.color || "#ff0000");
        cursorEl.style.transform = "rotate(-45deg)";

        // Add white outline to make it more visible
        cursorEl.style.filter =
          "drop-shadow(0 0 1px white) drop-shadow(0 0 2px rgba(0,0,0,0.5))";

        // Add user label
        const label = document.createElement("div");
        label.className = "blockly-cursor-label";
        label.textContent = state.name || "User";
        label.style.position = "absolute";
        label.style.bottom = "24px";
        label.style.left = "-4px";
        label.style.backgroundColor = state.color || "#ff0000";
        label.style.color = "#ffffff";
        label.style.padding = "2px 8px";
        label.style.borderRadius = "4px";
        label.style.fontSize = "12px";
        label.style.fontWeight = "bold";
        label.style.whiteSpace = "nowrap";
        label.style.boxShadow = "0 0 4px rgba(0,0,0,0.3)";

        cursorEl.appendChild(label);

        // Add to workspace container
        svgContainer.appendChild(cursorEl);

        // Store cursor reference
        cursors.set(clientId, { element: cursorEl, state, isSvgCursor: false });
      }

      // Update cursor position based on state
      updateCursorPosition(clientId);

      console.log(
        `Cursor created for user ${state.name || "Unknown"} (${clientId})`
      );
    } catch (error) {
      console.error("Error creating cursor:", error);
    }
  };

  // Remove a cursor element
  const removeCursor = (clientId: number) => {
    const cursor = cursors.get(clientId);
    if (cursor && cursor.element) {
      try {
        cursor.element.remove();
        console.log(`Removed cursor for client ${clientId}`);
      } catch (e) {
        console.error(
          `Error removing cursor element for client ${clientId}:`,
          e
        );
      }
    }

    cursors.delete(clientId);
  };

  // Update cursor position based on workspace coordinates
  const updateCursorPosition = (clientId: number) => {
    const cursor = cursors.get(clientId);
    if (!cursor || !cursor.state.cursor) return;

    try {
      // Get cursor position from state - these are in workspace coordinates
      const workspaceCoordinate = {
        x: cursor.state.cursor.x,
        y: cursor.state.cursor.y,
      };

      console.log(
        `[Cursor ${clientId}] Workspace Coords: (${workspaceCoordinate.x.toFixed(
          2
        )}, ${workspaceCoordinate.y.toFixed(2)})`
      );

      // If we're using SVG cursors, handle differently than DOM element cursors
      if (cursor.isSvgCursor) {
        // For SVG cursors, we set the transform attribute directly
        cursor.element.setAttribute(
          "transform",
          `translate(${workspaceCoordinate.x}, ${workspaceCoordinate.y})`
        );

        // We'll no longer create directional indicators as requested
        return;
      }

      // For DOM element cursors, convert workspace coordinates to screen coordinates
      try {
        // Get metrics for current viewport state
        const viewMetrics = workspace.getMetrics();
        const scale = workspace.scale || 1;

        // Get current scroll offsets
        const scrollLeft = viewMetrics?.viewLeft || 0;
        const scrollTop = viewMetrics?.viewTop || 0;

        // Convert workspace coordinates to screen coordinates
        // First adjust for scroll, then apply scale
        const screenX = (workspaceCoordinate.x - scrollLeft) * scale;
        const screenY = (workspaceCoordinate.y - scrollTop) * scale;

        // Set the cursor position directly using the calculated screen coordinates
        cursor.element.style.left = `${screenX}px`;
        cursor.element.style.top = `${screenY}px`;

        // Ensure the cursor is visible
        cursor.element.style.display = "block";
      } catch (error) {
        console.error(
          `Failed to convert workspace coordinates for client ${clientId}:`,
          error
        );
      }
    } catch (error) {
      console.error("Error updating cursor position:", error);
    }
  };

  // Update cursors for all users
  const awarenessChangeHandler = (changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    console.log("Awareness change detected:", changes);

    try {
      // Handle new or updated users
      [...changes.added, ...changes.updated].forEach((clientId) => {
        const state = provider.awareness.getStates().get(clientId);
        // Only process users that aren't the current user and have cursor data
        if (state && clientId !== provider.awareness.clientID && state.cursor) {
          if (!cursors.has(clientId)) {
            // If cursor doesn't exist yet, create it
            console.log(
              `Creating new cursor for user ${
                state.name || "Unknown"
              } (${clientId})`,
              state
            );
            createCursor(clientId, state);
          } else {
            // If cursor already exists, just update its state and position
            const cursor = cursors.get(clientId);
            if (cursor) {
              // Update state data but keep the DOM element the same
              cursor.state = state;
              // This will update the position without recreating the element
              updateCursorPosition(clientId);
            }
          }
        }
      });

      // Handle removed users
      changes.removed.forEach((clientId) => {
        console.log(`Removing cursor for client ${clientId}`);
        removeCursor(clientId);
      });

      // Update the user list
      updateUserList();
    } catch (error) {
      console.error("Error handling awareness change:", error);
    }
  };

  // Subscribe to awareness changes
  provider.awareness.on("change", awarenessChangeHandler);

  // Initialize cursors for existing users
  provider.awareness.getStates().forEach((state: any, clientId: number) => {
    if (clientId !== provider.awareness.clientID) {
      createCursor(clientId, state);
    }
  });

  // Initial user list update
  updateUserList();

  // Throttled mouse move handler to reduce network traffic
  const mouseMoveThrottled = throttle((e: any) => {
    try {
      // Only track if we have a valid workspace and provider
      if (!workspace || !provider.awareness || !provider.wsconnected) {
        return;
      }

      // Get screen coordinates
      const mouseEvent = e.getBrowserEvent ? e.getBrowserEvent() : e;
      const mouseX = mouseEvent.clientX;
      const mouseY = mouseEvent.clientY;

      console.log(`[Cursor Send] Raw Screen Coords: (${mouseX}, ${mouseY})`);

      // Convert screen coordinates to workspace coordinates
      try {
        // Get metrics for current viewport state
        const viewMetrics = workspace.getMetrics();
        const scale = workspace.scale || 1;

        // Calculate position relative to injection div
        const injectionDiv = workspace.getInjectionDiv();
        const rect = injectionDiv.getBoundingClientRect();
        const relativeX = mouseX - rect.left;
        const relativeY = mouseY - rect.top;

        // Calculate scroll offsets
        const scrollLeft = viewMetrics?.viewLeft || 0;
        const scrollTop = viewMetrics?.viewTop || 0;

        // Convert to workspace coordinates by:
        // 1. Dividing by scale to account for zoom
        // 2. Adding scroll offsets to get the absolute workspace position
        const workspacePosition = {
          x: relativeX / scale + scrollLeft,
          y: relativeY / scale + scrollTop,
        };

        console.log(
          `[Cursor Send] Workspace Coords: (${workspacePosition.x.toFixed(
            2
          )}, ${workspacePosition.y.toFixed(2)})`
        );

        // Update awareness with new cursor position in workspace coordinates
        const currentState = provider.awareness.getLocalState() || {};
        const currentCursor = currentState.cursor || { x: 0, y: 0 };

        // Only send updates if position changed significantly to reduce network traffic
        if (
          !currentCursor ||
          Math.abs(currentCursor.x - workspacePosition.x) > 0.1 ||
          Math.abs(currentCursor.y - workspacePosition.y) > 0.1
        ) {
          provider.awareness.setLocalState({
            ...currentState,
            cursor: {
              x: workspacePosition.x,
              y: workspacePosition.y,
            },
          });
        }
      } catch (error) {
        console.error(
          "Error converting screen to workspace coordinates:",
          error
        );
      }
    } catch (error) {
      console.error("Error tracking mouse position:", error);
    }
  }, 50); // Throttle to 50ms (20 updates per second)

  // Set up mouse tracking
  const onMouseMove = (e: any) => {
    mouseMoveThrottled(e);
  };

  // Add mouse move listener
  const injectionDivElement = workspace.getInjectionDiv();
  if (injectionDivElement) {
    injectionDivElement.addEventListener("mousemove", onMouseMove);
  }

  // Log connection status changes
  const connectionStatusHandler = (connected: boolean) => {
    console.log(
      "WebSocket connection status changed:",
      connected ? "connected" : "disconnected"
    );

    // Update connection status in UI
    if (statusElement) {
      statusElement.style.backgroundColor = connected
        ? "rgba(0, 128, 0, 0.7)"
        : "rgba(255, 0, 0, 0.7)";
    }

    // Refresh user list when connection is established
    if (connected) {
      updateUserList();
    }
  };

  // Listen for connection status changes
  if (provider.on) {
    provider.on("status", connectionStatusHandler);
  }

  // Return cleanup function
  return () => {
    // Remove all cursors
    cursors.forEach((cursor, clientId) => {
      removeCursor(clientId);
    });

    // Remove mouse move event listener
    const injectionDivElement = workspace.getInjectionDiv();
    if (injectionDivElement) {
      injectionDivElement.removeEventListener("mousemove", onMouseMove);
    }

    // Remove any scroll listeners added to the workspace
    if (workspace.removeChangeListener) {
      // We can't remove the specific listener we added, so we'll have to rely on the component unmount
      // to clean up all change listeners via Blockly's own cleanup
    }

    // Remove the user list element
    const userListEl = document.getElementById("blockly-user-list");
    if (userListEl) {
      userListEl.remove();
    }

    // Clean up the main status element
    const statusElement = document.getElementById("blockly-room-status");
    if (statusElement) {
      statusElement.remove();
    }

    console.log("Cursor tracking cleaned up");
  };
}

// Initialize collaboration for a specific room
export async function initCollaboration(
  roomId: string,
  userIdentifier: string,
  blocklyWorkspace: any,
  blockly: any
): Promise<any> {
  try {
    // Validate required parameters
    if (!roomId || !userIdentifier || !blocklyWorkspace) {
      console.error("Missing required parameters for initCollaboration");
      return {
        ydoc: null,
        provider: null,
        awareness: null,
        connected: false,
      };
    }

    // Get room data from Firestore
    const roomData = await getCachedRoomData(roomId);
    if (!roomData) {
      console.error("Room not found");
      return {
        ydoc: null,
        provider: null,
        awareness: null,
        connected: false,
      };
    }

    // Create Yjs document
    const ydoc = new Y.Doc();

    // Determine WebSocket URL based on environment
    let websocketUrl = "";
    if (typeof window !== "undefined") {
      const isProduction = process.env.NODE_ENV === "production";
      websocketUrl = isProduction
        ? "wss://blockly-websocket-server.onrender.com"
        : "ws://localhost:1234";

      console.log(`Using WebSocket URL: ${websocketUrl}`);
    }

    // Create custom WebSocket provider with explicit URL construction
    console.log("Creating custom WebSocket provider");

    // Format the room ID to be compatible with the WebSocket server
    // Remove the room_ prefix if it exists as the server may not expect it
    const formattedRoomId = roomId.startsWith("room_")
      ? roomId.substring(5) // Remove 'room_' prefix
      : roomId;

    let provider: WebsocketProvider | null = null;

    try {
      provider = new WebsocketProvider(
        websocketUrl, // Use base URL without any path
        formattedRoomId, // Set the room ID directly as the room name
        ydoc,
        { connect: true }
      );

      console.log(
        "WebSocket connection attempt with room ID:",
        formattedRoomId
      );

      // Try to log the full URL that will be constructed
      console.log(
        "Expected WebSocket URL:",
        websocketUrl + "/" + formattedRoomId
      );

      // Add enhanced debugging
      provider.on(
        "status",
        (event: { status: "connected" | "disconnected" | "connecting" }) => {
          console.log(`WebSocket connection status: ${event.status}`);
        }
      );

      provider.on("connection-error", (event: Event) => {
        console.error("WebSocket connection error", event);

        // Log the actual WebSocket URL used (most important debugging info)
        const wsInstance = (provider as any)._ws;
        if (wsInstance) {
          console.log("Actual WebSocket URL used:", wsInstance.url);
        }
      });

      provider.on("connection-close", (event: CloseEvent | null) => {
        if (event) {
          console.log(
            `WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`
          );
        } else {
          console.log("WebSocket connection closed (no event details)");
        }
      });

      // Ensure provider is connected before continuing
      if (!provider.wsconnected) {
        console.log("Explicitly connecting WebSocket provider");
        provider.connect();
      }
    } catch (error) {
      console.error("Error creating WebSocket provider:", error);
    }

    // Create user awareness with explicit association to the provider
    const awareness = provider ? provider.awareness : new Awareness(ydoc);

    // Set initial user state with color and name - always do this even if provider isn't available
    const userName = userIdentifier;
    const userColor = getRandomColor();

    awareness.setLocalState({
      name: userName,
      color: userColor,
      // Initialize with current cursor position to make it visible immediately
      cursor: { x: 0, y: 0 },
    });

    // Log awareness state for debugging
    console.log("Local awareness state set:", {
      name: userName,
      color: userColor,
      clientId: awareness.clientID,
    });

    // Explicitly sync awareness state if connected
    if (provider && provider.wsconnected) {
      console.log("Syncing awareness states");
      provider.awareness.setLocalStateField("presence", { status: "online" });
    }

    // Return the document, provider, and connection status
    return {
      ydoc,
      provider,
      awareness,
      connected: provider ? provider.wsconnected : false,
      blockly,
    };
  } catch (error) {
    console.error("Error initializing collaboration:", error);
    return {
      ydoc: null,
      provider: null,
      awareness: null,
      connected: false,
    };
  }
}

// Register user presence in a room
// Debounced to reduce Firestore writes
export const registerUserPresence = debounce(
  async (
    roomId: string,
    userId: string,
    userName: string,
    userEmail: string
  ) => {
    if (!roomId || !userId) return;

    try {
      // Check if room exists
      const roomRef = doc(db, "rooms", roomId);
      const roomDoc = await getDoc(roomRef);

      if (!roomDoc.exists()) {
        console.error("Room not found");
        return;
      }

      // Update user's last accessed time for this room (throttled)
      updateUserRoomActivityThrottled(userId, roomId);

      // Add this user to the room's userIds array if not already there
      await updateDoc(roomRef, {
        userIds: arrayUnion(userId),
        lastActivity: serverTimestamp(),
      });

      // Store user details in a separate users collection document
      // This avoids array field manipulation which is expensive in Firestore
      const userRef = doc(db, "rooms", roomId, "users", userId);
      await setDoc(
        userRef,
        {
          id: userId,
          name: userName || "Anonymous",
          email: userEmail || "",
          joinedAt: serverTimestamp(),
          lastActive: serverTimestamp(),
        },
        { merge: true }
      );

      // Clear cache to ensure fresh data
      clearRoomCache(roomId);
    } catch (error) {
      console.error("Error registering user presence:", error);
    }
  },
  3000
); // Debounce to reduce writes - only register once every 3 seconds

/**
 * Update room user list when a user joins or leaves
 * @param roomId Room ID
 * @param userId User ID
 * @param isPresent Boolean indicating if user is present (true) or left (false)
 */
export const updateRoomUserList = async (
  roomId: string,
  userId: string,
  isPresent: boolean
): Promise<void> => {
  if (!roomId || !userId) return;

  try {
    const roomRef = doc(db, "rooms", roomId);
    const roomDoc = await getDoc(roomRef);

    if (!roomDoc.exists()) {
      console.error(`Room ${roomId} does not exist`);
      return;
    }

    // Clear any cached data for this room
    clearRoomCache(roomId);

    if (isPresent) {
      // User is present, add to userIds if not already there
      await updateDoc(roomRef, {
        userIds: arrayUnion(userId),
        lastUpdated: serverTimestamp(),
      });
    } else {
      // User has left, remove from userIds
      await updateDoc(roomRef, {
        userIds: arrayRemove(userId),
        lastUpdated: serverTimestamp(),
      });
    }
  } catch (error) {
    console.error(`Error updating room user list for room ${roomId}:`, error);
    // Don't throw to avoid blocking the user from leaving
  }
};

// Delete a specific room
export async function deleteRoom(roomId: string): Promise<void> {
  try {
    // Get room data to find all users
    const roomRef = doc(db, "rooms", roomId);
    const roomSnapshot = await getDoc(roomRef);

    if (!roomSnapshot.exists()) {
      console.error("Room not found:", roomId);
      return;
    }

    const roomData = roomSnapshot.data();
    const userIds = roomData?.userIds || [];

    // Create a batch for multiple delete operations
    const batch = writeBatch(db);

    // 1. Delete users subcollection
    const usersCollectionRef = collection(db, "rooms", roomId, "users");
    const usersSnapshot = await getDocs(usersCollectionRef);
    usersSnapshot.docs.forEach((userDoc) => {
      batch.delete(doc(db, "rooms", roomId, "users", userDoc.id));
    });

    // 2. Delete the room from each user's rooms subcollection
    for (const userId of userIds as string[]) {
      const userRoomRef = doc(db, "users", userId, "rooms", roomId);
      batch.delete(userRoomRef);
    }

    // 3. Delete the main room document
    batch.delete(roomRef);

    // Execute all delete operations
    await batch.commit();

    // Clear any cached room data
    clearRoomCache(roomId);

    // Clear the users' room caches
    userIds.forEach((userId: string) => {
      userRoomsCache.delete(userId);
    });

    console.log("Successfully deleted room:", roomId);
  } catch (error) {
    console.error("Error deleting room:", error);
    throw error;
  }
}

// Clean up an orphaned room reference (when the room document doesn't exist in Firebase)
export async function cleanupOrphanedRoom(
  roomId: string,
  userId: string
): Promise<void> {
  if (!roomId || !userId) {
    console.error("Room ID and User ID are required for cleanup");
    throw new Error("Missing required parameters");
  }

  try {
    console.log(
      `Cleaning up orphaned room reference: ${roomId} for user: ${userId}`
    );

    // Create a batch for delete operations
    const batch = writeBatch(db);

    // Delete only the user's reference to the room
    const userRoomRef = doc(db, "users", userId, "rooms", roomId);
    batch.delete(userRoomRef);

    // Execute delete operation
    await batch.commit();

    // Clear any cached user room data
    userRoomsCache.delete(userId);

    console.log("Successfully cleaned up orphaned room reference");
  } catch (error) {
    console.error("Error cleaning up orphaned room:", error);
    throw error;
  }
}

// Clear all rooms (admin function)
export async function clearAllRooms(): Promise<void> {
  try {
    // Get all rooms
    const roomsRef = collection(db, "rooms");
    const roomsSnapshot = await getDocs(roomsRef);

    if (roomsSnapshot.empty) {
      console.log("No rooms to delete");
      return;
    }

    console.log(`Found ${roomsSnapshot.size} rooms to delete`);

    // Delete each room individually to handle subcollections
    const promises = roomsSnapshot.docs.map((roomDoc) =>
      deleteRoom(roomDoc.id)
    );

    await Promise.all(promises);

    // Clear all room caches
    roomDataCache.clear();
    roomUsersCache.clear();
    userRoomsCache.clear();

    console.log("Successfully cleared all rooms");
  } catch (error) {
    console.error("Error clearing all rooms:", error);
    throw error;
  }
}

// Helper to generate random name for anonymous users
function getRandomName() {
  const adjectives = [
    "Happy",
    "Quick",
    "Clever",
    "Brave",
    "Calm",
    "Eager",
    "Gentle",
    "Jolly",
  ];
  const nouns = [
    "Panda",
    "Tiger",
    "Eagle",
    "Dolphin",
    "Fox",
    "Wolf",
    "Owl",
    "Bear",
  ];

  const randomAdjective =
    adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];

  return `${randomAdjective}${randomNoun}`;
}

// Helper to generate random color for user cursors
function getRandomColor() {
  const colors = [
    "#4285F4", // Google Blue
    "#EA4335", // Google Red
    "#FBBC05", // Google Yellow
    "#34A853", // Google Green
    "#8142FF", // Purple
    "#FF5722", // Deep Orange
    "#03A9F4", // Light Blue
    "#009688", // Teal
  ];

  return colors[Math.floor(Math.random() * colors.length)];
}

// Type definitions for TypeScript
interface CollabSetup {
  ydoc: Y.Doc;
  provider: WebsocketProvider | null;
  awareness: Awareness;
  connected: boolean;
}
