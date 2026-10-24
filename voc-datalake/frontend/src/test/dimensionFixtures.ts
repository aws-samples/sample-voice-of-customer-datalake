/**
 * @fileoverview Shared wire fixtures for the dimensions / source-profile specs:
 * `product` with a child `module`, `user_type`, and profiles including a
 * restricted `support_tickets` (redact, 365 days) — the same shape the dev mock serves.
 */
const productDimension = {
  key: 'product', label: 'Product', infer: true,
  values: [{ name: 'mobile_app', label: 'Mobile app' }, { name: 'web_shop', label: 'Web shop' }],
}

const moduleDimension = {
  key: 'module', label: 'Module', infer: true, parent: 'product',
  values: [
    { name: 'login', label: 'Login', parent_value: 'mobile_app' },
    { name: 'checkout', label: 'Checkout', parent_value: 'web_shop' },
    { name: 'search', label: 'Search' },
  ],
}

const userTypeDimension = {
  key: 'user_type', label: 'User type', infer: false,
  values: [{ name: 'customer', label: 'Customer' }, { name: 'partner', label: 'Partner' }],
}

export const dimensionsWire = { dimensions: [productDimension, moduleDimension, userTypeDimension], updated_at: '2026-01-01T00:00:00Z' }

const salesProfile = {
  id: 'sales_csv', label: 'Sales CSV', pii: 'allow', retention_days: null, restricted: false,
  dimension_defaults: { user_type: 'partner' }, tags: ['sales'],
}

export const supportProfile = {
  id: 'support_tickets', label: 'Support tickets', pii: 'redact', retention_days: 365, restricted: true,
  dimension_defaults: {}, tags: ['support'],
}

export const sourcesWire = { sources: [salesProfile, supportProfile] }
