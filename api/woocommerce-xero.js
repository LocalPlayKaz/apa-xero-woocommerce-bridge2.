import axios from 'axios';
import { getXeroToken } from './xero-utils.js';

export async function processWooOrderToXero(order) {
  // If the payload is missing line items (status change, customer event, or test ping), skip gracefully
  if (!order || !order.line_items || !Array.isArray(order.line_items)) {
    console.log(`Webhook received for Order ID: ${order?.id || 'Unknown'} without line items. Skipping Xero sync.`);
    return { success: true, message: 'Webhook received, but no line items found to process.' };
  }

  const tokenData = await getXeroToken();

  // Map WooCommerce line items safely, supporting parent/child relationship structures
  const lineItems = order.line_items.map(item => {
    const metaData = item.meta_data || [];
    const parentMeta = metaData.find(m => m.key === '_parent_product' || m.key === 'parent_item');
    
    let description = item.name;
    if (parentMeta) {
      description = `[Child of #${parentMeta.value}] ${item.name}`;
    }

    return {
      Description: description,
      Quantity: item.quantity || 1,
      UnitAmount: item.price || 0,
      LineAmount: item.total || 0,
      AccountCode: '4500' // Configured to your accountant's specified revenue account code
    };
  });

  const invoice = {
    Type: 'ACCREC',
    Contact: {
      Name: order.billing ? `${order.billing.first_name || ''} ${order.billing.last_name || ''}`.trim() : 'WooCommerce Customer',
      EmailAddress: order.billing?.email || 'customer@example.com'
    },
    Date: order.date_created ? order.date_created.split('T')[0] : new Date().toISOString().split('T')[0],
    DueDate: order.date_created ? order.date_created.split('T')[0] : new Date().toISOString().split('T')[0],
    LineItems: lineItems,
    Status: 'AUTHORISED',
    Reference: `WooCommerce Order #${order.id || 'Test'}`
  };

  const tenantId = tokenData.tenant_id || process.env.XERO_TENANT_ID;
  if (!tenantId) {
    throw new Error('Missing Xero Tenant ID in Supabase or environment variables.');
  }

  try {
    const response = await axios.post(
      'https://api.xero.com/api.xro/2.0/Invoices',
      { Invoices: [invoice] },
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'Xero-tenant-id': tenantId,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (err) {
    const xeroError = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message;
    console.error('Xero API Rejection Details:', xeroError);
    throw new Error(`Xero validation failed: ${xeroError}`);
  }
}
