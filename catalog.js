// SkuLabs endpoint catalog, taken from the SkuLabs API reference
// (https://www.skulabs.com/api/). Paths are /<resource>/<action>.
// "read" actions only fetch data; everything else changes data.

const RAW = {
  batch: ["get"],
  customer: ["get_customer", "get_customers", "add_note", "add_tag", "remove_tag"],
  cycle_count: ["get", "get_all"],
  distributor: ["get", "create", "update", "add_item", "edit_item", "remove_item", "bulk_remove_item"],
  inventory: [
    "get", "get_items", "get_item_free", "get_items_map", "get_items_and_kits_map", "get_kits_map",
    "get_items_incoming", "get_on_hand_location_map", "get_grouped_locations_map", "get_reserved_map",
    "get_via_post_reserved_map", "get_history", "get_inventory_history", "get_received_history",
    "calculate_free_map",
    "upsert", "increase_on_hand", "decrease_on_hand", "bulk_reconciliation", "deduct_serial_numbers",
  ],
  inventory_table: ["export_velocity"],
  item: [
    "get", "get_locations", "find_by_barcode",
    "create", "create_upsert", "upsert", "update", "remove", "bulk_upsert", "bulk_assign", "bulk_remove",
    "add_barcode", "remove_barcode", "add_custom_field", "remove_custom_field", "add_serial_numbers",
    "remove_serial_number", "new_remove_serial_number", "add_tag", "remove_tag", "set_tags",
    "update_alias_locations",
  ],
  kit: [
    "get", "create", "update", "remove", "bulk_update", "add_item", "edit_item", "remove_item",
    "add_barcode", "remove_barcode", "add_custom_field", "remove_custom_field", "add_tag", "remove_tag", "set_tags",
  ],
  listing: ["get", "listing_links_csv_import", "rules_csv_import"],
  location: ["get", "get_all", "get_list", "get_items", "create", "add_item", "remove_item"],
  order: [
    "get", "get_all", "get_single", "get_single_bulk", "get_archived", "get_shipped",
    "get_by_base_order_number", "get_customs_information", "get_scanned_serial_numbers",
    "get_skipped_scans", "get_unscanned_items", "status", "unscanned_order_list", "undershipped_item_report",
    "add", "add_note", "add_tag", "add_tag_by_name", "remove_tag", "set_tags", "add_manual_shipment",
    "bulk_add_manual_shipments", "modify_status", "modify_financial_status", "override", "revert",
  ],
  purchase_order: [
    "get", "get_by_status", "get_closed", "get_closed_with_items", "get_processing",
    "get_processing_with_items", "get_processing_with_item_id", "get_single", "get_single_by_number",
    "get_single_bulk",
    "create", "create_v2", "new_create", "bulk_accept", "add_tag", "remove_tag", "set_tags",
  ],
  shipments: ["get", "get_by_range", "csv_export"],
  shipping: ["void", "restore_inventory", "set_manifested"],
  store: ["get"],
  tag: ["get", "add_tag", "update", "remove"],
  transfer_order: ["get", "get_all", "create"],
  warehouse: ["get", "stats", "create", "create_v2"],
};

const READ_EXTRA = new Set(["status", "stats", "unscanned_order_list", "undershipped_item_report", "export_velocity", "csv_export", "calculate_free_map"]);

export function isReadAction(action) {
  return action.startsWith("get") || action.startsWith("find") || READ_EXTRA.has(action);
}

// Read-only endpoints that SkuLabs expects as POST requests (JSON body).
export const READ_ONLY_POST = new Set([
  "/inventory/get_items",
  "/inventory/get_on_hand_location_map",
  "/inventory/get_via_post_reserved_map",
]);

export const ENDPOINTS = Object.entries(RAW).flatMap(([resource, actions]) =>
  actions.map((action) => ({ path: `/${resource}/${action}`, kind: isReadAction(action) ? "read" : "write" }))
);

export const KNOWN_PATHS = new Set(ENDPOINTS.map((e) => e.path));

export function catalogText() {
  const lines = [];
  for (const [resource, actions] of Object.entries(RAW)) {
    const reads = actions.filter(isReadAction);
    const writes = actions.filter((a) => !isReadAction(a));
    lines.push(`${resource}:`);
    if (reads.length) lines.push(`  read:  ${reads.map((a) => `/${resource}/${a}`).join(", ")}`);
    if (writes.length) lines.push(`  write: ${writes.map((a) => `/${resource}/${a}`).join(", ")}`);
  }
  return lines.join("\n");
}
