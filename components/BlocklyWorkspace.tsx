import React, { useEffect, useRef, useState } from "react";
import styles from "../styles/BlocklyWorkspace.module.css";
import { BlocklyOptions } from "blockly";
import {
  initCollaboration,
  setupBlocklySync,
  setupCursorTracking,
} from "../lib/collab";

interface BlocklyWorkspaceProps {
  roomId?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  initialXml?: string;
  onConnectionStatusChange?: (connected: boolean) => void;
  onUserCountChange?: (count: number) => void;
  onBlocklyInit?: (instance: any) => void;
}

const BlocklyWorkspace: React.FC<BlocklyWorkspaceProps> = ({
  roomId = "default-room",
  userId = "anonymous",
  userName = "Anonymous User",
  userEmail = "anonymous@example.com",
  initialXml,
  onConnectionStatusChange,
  onUserCountChange,
  onBlocklyInit,
}) => {
  const blocklyDiv = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<any>(null);
  const [generatedCode, setGeneratedCode] = useState<string>("");
  const [showCode, setShowCode] = useState<boolean>(true);
  const [collaborationStatus, setCollaborationStatus] = useState<string>(
    "Initializing collaboration..."
  );
  const [userCount, setUserCount] = useState<number>(1);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [debugInfo, setDebugInfo] = useState<string>("");
  const blocklyInstanceRef = useRef<any>(null);
  const handleResizeRef = useRef<(() => void) | null>(null);

  // Update parent component with connection status
  useEffect(() => {
    if (onConnectionStatusChange) {
      onConnectionStatusChange(isConnected);
    }
  }, [isConnected, onConnectionStatusChange]);

  // Update parent component with user count
  useEffect(() => {
    if (onUserCountChange) {
      onUserCountChange(userCount);
    }
  }, [userCount, onUserCountChange]);

  // Share Blockly instance with parent component
  useEffect(() => {
    if (blocklyInstanceRef.current && onBlocklyInit) {
      onBlocklyInit(blocklyInstanceRef.current);
    }
  }, [workspace, onBlocklyInit]);

  // Ensure Blockly has time to initialize in production
  useEffect(() => {
    if (typeof window !== "undefined") {
      // Force resize window to ensure Blockly renders correctly
      const handleResize = () => {
        if (workspace) {
          try {
            workspace.resize();
            setDebugInfo("Resize triggered");
          } catch (err) {
            console.error("Error during resize:", err);
          }
        }
      };

      // Wait for DOM to be fully loaded
      window.addEventListener("load", () => {
        if (blocklyDiv.current) {
          setDebugInfo("Window loaded, div exists");
          setTimeout(handleResize, 500);
        }
      });

      window.addEventListener("resize", handleResize);

      handleResizeRef.current = handleResize;

      return () => {
        window.removeEventListener("resize", handleResize);
      };
    }
  }, [workspace]);

  useEffect(() => {
    let blocklyInstance: any = null;
    let collaborationCleanup: (() => void) | null = null;

    // Only run on client-side
    if (typeof window === "undefined" || !blocklyDiv.current) {
      return;
    }

    // Flag to prevent multiple initializations
    let isInitialized = false;

    // Dynamically import Blockly
    const initBlockly = async () => {
      if (isInitialized) return;

      try {
        setIsLoading(true);
        setDebugInfo("Loading Blockly...");

        // Import Blockly and necessary components
        const Blockly = await import("blockly");
        setDebugInfo("Blockly loaded");
        const BlocklyJS = await import("blockly/javascript");

        // Make sure we have all the blocks we need
        await import("blockly/blocks");
        setDebugInfo("Blockly blocks loaded");

        // Apply custom category styling after load
        const applyCustomStyles = () => {
          // Find all category rows and add data attributes for CSS targeting
          const categoryRows = document.querySelectorAll(".blocklyTreeRow");
          categoryRows.forEach((row) => {
            const label = row.querySelector(".blocklyTreeLabel");
            if (label) {
              const category = label.textContent?.toLowerCase().trim();
              if (category) {
                (row as HTMLElement).dataset.category = category;

                // Add icon before the category label
                const iconExists = row.querySelector(".category-icon");
                if (!iconExists) {
                  const iconImg = document.createElement("img");
                  iconImg.src = `/images/blockly-icons/${category}.svg`;
                  iconImg.className = "category-icon";
                  iconImg.alt = `${category} icon`;
                  iconImg.width = 20;
                  iconImg.height = 20;

                  // Insert before the label
                  if (label.parentNode) {
                    label.parentNode.insertBefore(iconImg, label);
                  }
                }
              }
            }
          });

          // Improve the flyout appearance for better UX
          const flyoutBtns = document.querySelectorAll(".blocklyFlyoutButton");
          flyoutBtns.forEach((btn) => {
            (btn as HTMLElement).style.filter =
              "drop-shadow(0px 1px 3px rgba(0,0,0,0.3))";
          });
        };

        // Configure workspace
        const options: BlocklyOptions = {
          toolbox: getToolboxConfiguration(),
          grid: {
            spacing: 20,
            length: 3,
            colour: "#ccc",
            snap: true,
          },
          trashcan: true,
          zoom: {
            controls: true,
            wheel: true,
            startScale: 1.0,
            maxScale: 3,
            minScale: 0.3,
            scaleSpeed: 1.2,
          },
          move: {
            scrollbars: true, // Enable scrollbars
            drag: true,
            wheel: true,
          },
          // Set a fixed size to the workspace content (prevents infinite growth)
          // This creates a bounded workspace like Figma
          maxInstances: {}, // Allow unlimited instances of each block
          scrollbars: true,
          comments: true,
          collapse: true,
          sounds: true,
          media: "https://blockly-demo.appspot.com/static/media/",
          renderer: "geras",
        };

        // Clear any previous workspace
        if (blocklyDiv.current) {
          blocklyDiv.current.innerHTML = "";
          // Ensure the div is visible and has dimensions
          blocklyDiv.current.style.width = "100%";
          blocklyDiv.current.style.height = "600px"; // Set explicit height
          blocklyDiv.current.style.display = "block";
          blocklyDiv.current.style.visibility = "visible";
          setDebugInfo("Blockly div prepared");
        }

        // Create the Blockly workspace - Fix the null issue by asserting non-null
        setDebugInfo("Injecting Blockly...");
        const newWorkspace = Blockly.inject(blocklyDiv.current!, options);
        setDebugInfo("Blockly injected successfully");

        // Set up fixed size workspace (like Figma's bounded canvas)
        const setupFixedWorkspace = () => {
          try {
            // Center the view initially
            newWorkspace.scrollCenter();

            // Define a workspace boundary - this creates a fixed 2000x2000 canvas
            // centered at (0,0), similar to Figma's bounded canvas
            const canvasSize = 2000;
            const halfSize = canvasSize / 2;

            // Set the logical workspace boundary
            if (typeof newWorkspace.setScale === "function") {
              // Force a re-render of the workspace after setting up
              newWorkspace.setScale(newWorkspace.scale);

              // Save the boundary for other code to reference
              (newWorkspace as any).canvasBounds = {
                width: canvasSize,
                height: canvasSize,
                left: -halfSize,
                top: -halfSize,
                right: halfSize,
                bottom: halfSize,
              };

              console.log(
                "Fixed-size workspace created:",
                canvasSize,
                "x",
                canvasSize
              );
            }
          } catch (error) {
            console.error("Error setting up fixed workspace:", error);
          }
        };

        // Set up the fixed workspace immediately
        setupFixedWorkspace();

        // Handle resize events
        const handleResize = () => {
          if (blocklyDiv.current && newWorkspace) {
            // Resize the workspace
            Blockly.svgResize(newWorkspace);
          }
        };

        // Add resize event listener
        window.addEventListener("resize", handleResize);

        // Store Blockly instance with workspace for external access
        const blocklyWithWorkspace = {
          workspace: newWorkspace,
          Blockly: Blockly,
          workspaceToXml: () => {
            try {
              const xml = (Blockly as any).Xml.workspaceToDom(newWorkspace);
              return (Blockly as any).Xml.domToText(xml);
            } catch (err) {
              console.error("Error converting workspace to XML:", err);
              return "";
            }
          },
        };

        setWorkspace(newWorkspace);
        blocklyInstance = newWorkspace;
        blocklyInstanceRef.current = blocklyWithWorkspace;

        // Apply our custom styling to the toolbox categories
        setTimeout(applyCustomStyles, 100);

        // Add change listener to generate code
        const updateCode = () => {
          try {
            const code =
              BlocklyJS.javascriptGenerator.workspaceToCode(newWorkspace);
            setGeneratedCode(code);
            console.log("Generated code:", code);
          } catch (err) {
            console.error("Error generating code:", err);
          }
        };

        // Register for changes to the workspace
        newWorkspace.addChangeListener((e: any) => {
          // Only update when changes are done (not during drags, etc)
          if (
            e.type === Blockly.Events.BLOCK_MOVE ||
            e.type === Blockly.Events.BLOCK_CHANGE ||
            e.type === Blockly.Events.BLOCK_CREATE ||
            e.type === Blockly.Events.BLOCK_DELETE
          ) {
            updateCode();
          }
        });

        // Re-apply styles when toolbox changes are made
        newWorkspace.addChangeListener((e: any) => {
          if (e.type === Blockly.Events.TOOLBOX_ITEM_SELECT) {
            setTimeout(applyCustomStyles, 200); // Increased timeout for more reliable icon insertion
          }
        });

        // Also reapply styles on window resize to ensure icons stay in place
        window.addEventListener("resize", () => {
          setTimeout(applyCustomStyles, 200);
        });

        // Load initial XML if provided
        if (initialXml && Blockly) {
          try {
            // Use type assertion to help TypeScript recognize Blockly.Xml
            const xml = (Blockly as any).Xml.textToDom(initialXml);
            newWorkspace.clear();
            (Blockly as any).Xml.domToWorkspace(xml, newWorkspace);
          } catch (err) {
            console.error("Error loading initial XML:", err);
          }
        }

        // Set up collaboration features after workspace is created
        try {
          setCollaborationStatus("Connecting to collaboration server...");
          setIsConnected(false);

          // Initialize collaboration - Pass Blockly properly as an object
          const { ydoc, provider, awareness, connected } =
            await initCollaboration(
              roomId,
              userId,
              newWorkspace,
              Blockly // Make sure this is passed correctly as the Blockly instance
            );

          // Set up Blockly synchronization with proper Blockly reference
          const cleanup = setupBlocklySync(newWorkspace, ydoc, {
            blockly: Blockly, // This correctly passes the Blockly API
          });

          // Set up cursor tracking if the provider is available
          if (blocklyDiv.current && provider) {
            const cursorCleanup = setupCursorTracking(
              newWorkspace,
              ydoc,
              provider,
              {
                name: userName || userEmail.split("@")[0] || userId, // Use userName first, then fallback
                email: userEmail,
                color: generateUserColor(userId),
              }
            );

            // Store cursor cleanup function
            const originalCleanup = collaborationCleanup;
            collaborationCleanup = () => {
              if (originalCleanup) originalCleanup();
              if (cursorCleanup) cursorCleanup();
            };
          }

          // Update initial connection status
          setIsConnected(connected);
          if (connected) {
            setCollaborationStatus(`Connected to room: ${roomId}`);
          } else {
            setCollaborationStatus("Disconnected from collaboration server");
          }

          // Set up listeners for connection changes
          if (provider) {
            provider.on("status", (event: { status: string }) => {
              console.log("Connection status:", event.status);

              if (event.status === "connected") {
                setIsConnected(true);
                setCollaborationStatus(`Connected to room: ${roomId}`);
                if (onConnectionStatusChange) onConnectionStatusChange(true);
              } else if (event.status === "disconnected") {
                setIsConnected(false);
                setCollaborationStatus(
                  "Disconnected from collaboration server"
                );
                if (onConnectionStatusChange) onConnectionStatusChange(false);
              }
            });
          }

          // Set up user count tracking with callback
          awareness.on("change", () => {
            const count = Array.from(awareness.getStates().keys()).length;
            setUserCount(count);
            if (onUserCountChange) onUserCountChange(count);
          });

          // Store the collaboration cleanup
          if (!collaborationCleanup) {
            collaborationCleanup = cleanup;
          }
        } catch (error) {
          console.error("Error setting up collaboration:", error);
          setCollaborationStatus("Error connecting to collaboration server");
        }

        isInitialized = true;
        setIsLoading(false);
        setDebugInfo("Blockly fully initialized");
      } catch (error) {
        console.error("Error initializing Blockly:", error);
        setIsLoading(false);
        setDebugInfo(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    // Initialize Blockly
    initBlockly();

    // Cleanup function
    return () => {
      // Clean up resize listener
      window.removeEventListener("resize", handleResizeRef.current!);

      if (blocklyInstance) {
        blocklyInstance.dispose();
        blocklyInstance = null;
      }

      if (collaborationCleanup) {
        collaborationCleanup();
      }

      if (workspace) {
        try {
          workspace.dispose();
        } catch (error) {
          console.error("Error disposing of workspace:", error);
        }
      }

      window.removeEventListener("resize", () => {});
    };
  }, [roomId]); // Only re-run if roomId changes

  // Handle page unload to clean up resources
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Send a beacon to the room-leave API to update user presence
      const apiUrl = `/api/room-leave?roomId=${encodeURIComponent(
        roomId
      )}&userId=${encodeURIComponent(userId)}`;
      navigator.sendBeacon(apiUrl);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);

      // Also clean up when component unmounts (navigate away or logout)
      const apiUrl = `/api/room-leave?roomId=${encodeURIComponent(
        roomId
      )}&userId=${encodeURIComponent(userId)}`;
      navigator.sendBeacon(apiUrl);
    };
  }, [roomId, userId]);

  // Generate toolbox configuration
  function getToolboxConfiguration() {
    return {
      kind: "categoryToolbox",
      contents: [
        {
          kind: "category",
          name: "Logic",
          colour: "#5C81A6",
          contents: [
            {
              kind: "block",
              type: "controls_if",
            },
            {
              kind: "block",
              type: "logic_compare",
            },
            {
              kind: "block",
              type: "logic_operation",
            },
            {
              kind: "block",
              type: "logic_negate",
            },
            {
              kind: "block",
              type: "logic_boolean",
            },
          ],
        },
        {
          kind: "category",
          name: "Loops",
          colour: "#5CA65C",
          contents: [
            {
              kind: "block",
              type: "controls_repeat_ext",
            },
            {
              kind: "block",
              type: "controls_whileUntil",
            },
            {
              kind: "block",
              type: "controls_for",
            },
            {
              kind: "block",
              type: "controls_forEach",
            },
          ],
        },
        {
          kind: "category",
          name: "Math",
          colour: "#5C68A6",
          contents: [
            {
              kind: "block",
              type: "math_number",
            },
            {
              kind: "block",
              type: "math_arithmetic",
            },
            {
              kind: "block",
              type: "math_single",
            },
            {
              kind: "block",
              type: "math_round",
            },
          ],
        },
        {
          kind: "category",
          name: "Text",
          colour: "#5CA6A6",
          contents: [
            {
              kind: "block",
              type: "text",
            },
            {
              kind: "block",
              type: "text_join",
            },
            {
              kind: "block",
              type: "text_append",
            },
            {
              kind: "block",
              type: "text_length",
            },
          ],
        },
        {
          kind: "category",
          name: "Variables",
          colour: "#A65CA6",
          custom: "VARIABLE",
        },
        {
          kind: "category",
          name: "Functions",
          colour: "#9A5CA6",
          custom: "PROCEDURE",
        },
      ],
    };
  }

  // Generate a color based on user ID for consistent colors per user
  const generateUserColor = (userId: string): string => {
    // Simple hash function to generate a number from a string
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Convert to RGB color
    const c = (hash & 0x00ffffff).toString(16).toUpperCase();

    return "#" + "00000".substring(0, 6 - c.length) + c;
  };

  return (
    <div className={styles.blocklyContainer}>
      {isLoading && (
        <div className={styles.blocklyLoading}>
          Loading Blockly workspace...
          <div className={styles.debugInfo}>{debugInfo}</div>
        </div>
      )}

      <div ref={blocklyDiv} className={styles.blocklyDiv}></div>

      {showCode && generatedCode && (
        <div className={styles.codeContainer}>
          <div className={styles.codeHeader}>
            <h3>Generated JavaScript:</h3>
            <button
              onClick={() => setShowCode(!showCode)}
              className={styles.hideCodeButton}
            >
              Hide Code
            </button>
          </div>
          <pre className={styles.codeDisplay}>
            {generatedCode || "// No code generated yet"}
          </pre>
        </div>
      )}
    </div>
  );
};

export default BlocklyWorkspace;
