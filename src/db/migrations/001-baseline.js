'use strict';

// #360 [K1]: baseline marker. The 20+ ALTER blocks at the top of src/db.js
// predate this runner. They stay there (idempotent, in-prod). This file is
// the runner's anchor point — any new schema change adds 002-name.js,
// 003-name.js, etc.

module.exports.up = function up(_db) {
  // intentionally empty — baseline anchor
};
