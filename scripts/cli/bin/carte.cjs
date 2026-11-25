#!/usr/bin/env node

// Default to the arrow-key menu so `carte` works without a GUI; on Windows
// especially, the tray icon can land in the hidden-icons overflow and never
// be seen. `carte --tray` still opts into the system-tray icon.
if (process.argv.length <= 2) process.argv.push("menu");
else if (process.argv[2] === "--tray") process.argv[2] = "tray";
require("./cartethyia.cjs");
