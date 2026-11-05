import axios from 'axios';
import { getXeroToken } from './auth.js';

export async function processWooOrderToXero(order) {
  const tokenData = await getXeroToken();

  // Map WooCommerce line items, supporting parent/child relationship structures
  const lineItems = order.line_items.map(item => {
    // Check for parent/child metadata or grouping if applicable
    const metaData = item.meta_data || [];
    const parentMeta = metaData.find(m => m.key === '_parent_product' || m.key === 'parent_item');
    
    let description = item.name;
    if (parentMeta) {
      description = `[Child of #${parentMeta.value}] ${item.name}`;
    }

    return {
      Description: description,
      Quantity: item.quantity,
      UnitAmount: item.price,
      LineAmount: item.total,
      AccountCode: '200' // Adjust to your Xero sales account code
    };
  });

  const invoice = {
    Type: 'ACCREC',
    Contact: {
      Name: `${order.billing.first_name} ${order.billing.last_name}`,
      EmailAddress: order.billing.email
    },
    Date: order.date_created.split('T')[0],
    DueDate: order.date_created.split('T')[0],
    LineItems: lineItems,
    Status: 'AUTHORISED',
    Reference: `WooCommerce Order #${order.id}`
  };

  // Send to Xero API using the active access token
  const response = await axios.post(
    'https://api.xero.com/api.x.0/Invoices',
    { Invoices: [invoice] },
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Xero-tenant-id': process.env.XERO_TENANT_ID,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}
