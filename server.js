// server.js - Node.js API שמושך מחירים ממשרד הכלכלה

import express from 'express';
import axios from 'axios';
import unzipper from 'unzipper';
import xml2js from 'xml2js';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3000;

let products = []; // כאן יאוחסן המידע

// נתיב ציבורי שמחזיר את המוצרים
app.get('/api/products', (req, res) => {
  res.json(products);
});

// פונקציה שמבצעת משיכה וניתוח של קובץ ZIP
async function fetchAndParseZip() {
  const zipUrl = 'https://prices.shufersal.co.il/FileObject/PriceFull/0/0/106/106_202405071511.zip'
; // כאן תכניס כתובת אמיתית
  const response = await axios.get(zipUrl, { responseType: 'arraybuffer' });

  const directory = await unzipper.Open.buffer(Buffer.from(response.data));
  const xmlFiles = [];

  for (const entry of directory.files) {
    if (entry.path.endsWith('.xml')) {
      const content = await entry.buffer();
      const parsed = await xml2js.parseStringPromise(content);
      const items = parsed?.Root?.Items?.[0]?.Item || [];

      const mapped = items.map(item => ({
        name: item.ItemName?.[0],
        quantity: Number(item.Quantity?.[0] || 1),
        unit: item.UnitQty?.[0] || 'יחידה',
        price: Number(item.ItemPrice?.[0] || 0)
      }));

      xmlFiles.push(...mapped);
    }
  }

  products = xmlFiles.slice(0, 100); // לדוגמה ניקח רק 100
  console.log(`עודכנו ${products.length} מוצרים`);
}

// להריץ כל 24 שעות
cron.schedule('0 0 * * *', () => {
  console.log('🕓 עדכון מחירים יומי...');
  fetchAndParseZip().catch(err => console.error('שגיאה:', err));
});

// הרצה ראשונית
fetchAndParseZip().catch(console.error);

app.listen(PORT, () => {
  console.log(`✅ API פעיל בכתובת http://localhost:${PORT}`);
});
