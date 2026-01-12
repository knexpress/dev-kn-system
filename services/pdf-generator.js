const { jsPDF } = require('jspdf');
const axios = require('axios');

/**
 * Generate PDF for booking data
 * Adapted from pdfGenerator.ts for Node.js backend
 */
async function generateBookingPDF(data) {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  let yPos = margin;

  // Determine route - handle various service name formats
  const serviceLower = (data.service || '').toLowerCase();
  const isPhToUae = serviceLower.includes('ph-to-uae') || serviceLower.includes('ph_to_uae');
  const routeDisplay = isPhToUae ? 'PH TO UAE' : 'UAE TO PHILIPPINES';
  
  console.log(`🔍 PDF Generation - Service: "${data.service}", isPhToUae: ${isPhToUae}, Route: ${routeDisplay}`);

  // Helper function to add new page
  const addNewPage = () => {
    doc.addPage();
    yPos = margin;
  };

  // Helper function to draw a line
  const drawLine = (y, startX = margin, endX = pageWidth - margin) => {
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.5);
    doc.line(startX, y, endX, y);
  };

  // Helper function to draw a box/rectangle
  const drawBox = (x, y, width, height, fillColor) => {
    if (fillColor) {
      doc.setFillColor(fillColor[0], fillColor[1], fillColor[2]);
      doc.rect(x, y, width, height, 'F');
    } else {
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.5);
      doc.rect(x, y, width, height);
    }
  };

  // Helper function to add Banned Items section
  const addBannedItemsSection = () => {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 128, 0);
    doc.text('BANNED ITEMS', margin, yPos);
    yPos += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text('Please be reminded that the following items are STRICTLY PROHIBITED from shipment:', margin, yPos);
    yPos += 8;

    const bannedItems = [
      'Flammable / Explosive Items',
      'Deadly Weapons',
      'Illegal Drugs / Vape / Cigarettes / Alcoholic Drinks',
      'Expensive / Original Jewelries (gold or silver)',
      'Money / Cash',
      'Live Animals',
      'Frozen Goods / Any Pork Items',
      'Medicines / Supplements / Capsules / Vitamins / Injectables',
      'Adult Toys',
      'Religious Items',
      'Long items (more than 200 cm are not allowed)',
      'Contact lens / Eye drops / Eye solution',
      'Perishable Goods (spoils easily)',
    ];

    bannedItems.forEach((item) => {
      doc.text(`• ${item}`, margin, yPos);
      yPos += 5;
    });
    yPos += 6;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Anything Illegal is STRICTLY BANNED.', margin, yPos);
    yPos += 10;
  };

  // Helper function to add image to PDF (Node.js version)
  const addImageToPDF = async (imageData, x, y, width, maxHeight) => {
    try {
      if (!imageData || imageData.trim() === '') {
        console.warn('Image data is empty or undefined');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.text('Image not available', x, y + 5);
        return 20;
      }

      let imageBuffer;
      let format = 'JPEG';

      // Handle different image data formats
      if (imageData.startsWith('data:image/png')) {
        format = 'PNG';
        const base64Data = imageData.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else if (imageData.startsWith('data:image/jpeg') || imageData.startsWith('data:image/jpg')) {
        format = 'JPEG';
        const base64Data = imageData.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
        // Download image from URL
        const response = await axios.get(imageData, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
        // Try to detect format from content-type
        const contentType = response.headers['content-type'];
        if (contentType && contentType.includes('png')) {
          format = 'PNG';
        }
      } else {
        // Assume it's already base64 without data URL prefix
        imageBuffer = Buffer.from(imageData, 'base64');
        if (imageData.startsWith('iVBORw0KGgo')) {
          format = 'PNG';
        }
      }

      // Add image to PDF
      const imgData = `data:image/${format.toLowerCase()};base64,${imageBuffer.toString('base64')}`;
      const imgHeight = Math.min((width * 0.75), maxHeight || 100); // Default aspect ratio
      
      doc.addImage(imgData, format, x, y, width, imgHeight);
      console.log(`✅ Image added successfully: ${width}x${imgHeight} at (${x}, ${y})`);
      
      return imgHeight;
    } catch (error) {
      console.error(`❌ Error adding image to PDF:`, error);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text('Image not available', x, y + 5);
      return 20;
    }
  };

  // ============================================
  // PAGE 1: BOOKING FORM
  // ============================================
  
  // Header Section
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 128, 0);
  doc.text('KNEX DELIVERY SERVICES L.L.C', margin, yPos);
  yPos += 6;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 0, 0);
  doc.text('Rocky Warehouse Warehouse #19, 11th Street, Al Qusais Industrial Area 1, Dubai, 0000 United Arab Emirates', margin, yPos);
  yPos += 4;
  doc.text('+971559738713', margin, yPos);
  yPos += 6;

  // AWB Number
  if (data.awb) {
    yPos += 4;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 128, 0);
    doc.text('AWB:', margin, yPos);
    doc.setFontSize(16);
    doc.text(data.awb, margin + 20, yPos);
    yPos += 8;
  }

  // Route display
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 128, 0);
  doc.text(routeDisplay, margin, yPos);
  yPos += 8;

  // Timestamp
  const timestamp = data.submissionTimestamp || new Date().toISOString();
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 0, 0);
  doc.text(`Generated: ${new Date(timestamp).toLocaleString()}`, margin, yPos);
  yPos += 6;

  drawLine(yPos);
  yPos += 10;

  // Sender and Receiver Details (Two Columns)
  const columnWidth = (pageWidth - (margin * 3)) / 2;
  const leftColumnX = margin;
  const rightColumnX = margin * 2 + columnWidth;
  const startY = yPos;

  // Left Column - Sender Details
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 128, 0);
  const senderLabel = isPhToUae ? '(PH) SENDER DETAILS' : '(UAE) SENDER DETAILS';
  doc.text(senderLabel, leftColumnX, yPos);
  yPos += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  
  // Name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('NAME', leftColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(data.sender.fullName || '', leftColumnX, yPos);
  yPos += 8;

  // Complete Address
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('COMPLETE ADDRESS', leftColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const addressLines = doc.splitTextToSize(data.sender.completeAddress || '', columnWidth - 2);
  addressLines.forEach((line) => {
    doc.text(line, leftColumnX, yPos);
    yPos += 4;
  });
  yPos += 4;

  // Contact No
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('CONTACT NO.', leftColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(data.sender.contactNo || '', leftColumnX, yPos);
  yPos += 8;

  // Email Address
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('EMAIL ADDRESS', leftColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(data.sender.emailAddress || '', leftColumnX, yPos);
  yPos += 8;

  // Agent Name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('AGENT NAME', leftColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(data.sender.agentName || '', leftColumnX, yPos);
  yPos += 8;

  // Delivery Options
  doc.setFontSize(7);
  if (isPhToUae) {
    const isDropOffToWarehouse = data.sender.deliveryOption === 'warehouse';
    const isSchedulePickup = data.sender.deliveryOption === 'pickup';
    
    doc.text(isDropOffToWarehouse ? '☑' : '☐', leftColumnX, yPos);
    doc.text('DROP OFF TO WAREHOUSE', leftColumnX + 5, yPos);
    yPos += 4;
    
    doc.text(isSchedulePickup ? '☑' : '☐', leftColumnX, yPos);
    doc.text('SCHEDULE A PICKUP', leftColumnX + 5, yPos);
  } else {
    const isWarehousePickup = data.sender.deliveryOption === 'warehouse' || data.sender.deliveryOption === 'pickup';
    const isDeliverToAddress = data.receiver.deliveryOption === 'address';
    
    doc.text(isWarehousePickup ? '☑' : '☐', leftColumnX, yPos);
    doc.text('UAE WAREHOUSE PICK-UP', leftColumnX + 5, yPos);
    yPos += 4;
    
    doc.text(isDeliverToAddress ? '☑' : '☐', leftColumnX, yPos);
    doc.text('DELIVER TO UAE ADDRESS', leftColumnX + 5, yPos);
  }
  yPos += 8;

  // Right Column - Receiver Details
  yPos = startY;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 128, 0);
  const receiverLabel = isPhToUae ? '(UAE) RECEIVER DETAILS' : '(PH) RECEIVER DETAILS';
  doc.text(receiverLabel, rightColumnX, yPos);
  yPos += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);

  // Name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('NAME', rightColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(data.receiver.fullName || '', rightColumnX, yPos);
  yPos += 8;

  // Complete Address
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('COMPLETE ADDRESS', rightColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const receiverAddressLines = doc.splitTextToSize(data.receiver.completeAddress || '', columnWidth - 2);
  receiverAddressLines.forEach((line) => {
    doc.text(line, rightColumnX, yPos);
    yPos += 4;
  });
  yPos += 4;

  // Contact No
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('CONTACT NO.', rightColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(data.receiver.contactNo || '', rightColumnX, yPos);
  yPos += 8;

  // Email Address
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('EMAIL ADDRESS', rightColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(data.receiver.emailAddress || '', rightColumnX, yPos);
  yPos += 8;

  // Number of Box/Parcel
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('NUMBER OF BOX / PARCEL', rightColumnX, yPos);
  yPos += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text((data.receiver.numberOfBoxes || '').toString(), rightColumnX, yPos);
  yPos += 8;

  const maxY = Math.max(yPos, startY + 80);
  yPos = maxY + 5;

  // Items Declaration Table
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Commodity | Items Declaration', margin, yPos);
  yPos += 8;

  const totalItems = data.items ? data.items.length : 0;
  const itemsPerTable = Math.ceil(totalItems / 2);
  const leftTableRows = itemsPerTable;
  const rightTableRows = totalItems - itemsPerTable;

  const tableWidth = (pageWidth - (margin * 3)) / 2;
  const tableStartY = yPos;
  const rowHeight = 6;
  const headerHeight = 8;

  // Left Table
  const leftTableX = margin;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  
  drawBox(leftTableX, tableStartY, tableWidth, headerHeight);
  doc.text('NO.', leftTableX + 2, tableStartY + 5);
  doc.text('COMMODITY | ITEMS', leftTableX + 12, tableStartY + 5);
  doc.text('QTY', leftTableX + tableWidth - 15, tableStartY + 5);

  for (let i = 0; i < leftTableRows; i++) {
    const rowY = tableStartY + headerHeight + (i * rowHeight);
    drawBox(leftTableX, rowY, tableWidth, rowHeight);
    doc.setFont('helvetica', 'normal');
    
    if (data.items && data.items[i]) {
      const item = data.items[i];
      doc.text((i + 1).toString(), leftTableX + 2, rowY + 4);
      const commodityLines = doc.splitTextToSize(item.commodity || '', tableWidth - 25);
      doc.text(commodityLines[0] || '', leftTableX + 12, rowY + 4);
      doc.text(item.qty.toString(), leftTableX + tableWidth - 15, rowY + 4);
    } else {
      doc.text((i + 1).toString(), leftTableX + 2, rowY + 4);
    }
  }

  // Right Table
  const rightTableX = margin * 2 + tableWidth;
  doc.setFont('helvetica', 'bold');
  
  drawBox(rightTableX, tableStartY, tableWidth, headerHeight);
  doc.text('NO.', rightTableX + 2, tableStartY + 5);
  doc.text('COMMODITY | ITEMS', rightTableX + 12, tableStartY + 5);
  doc.text('QTY', rightTableX + tableWidth - 15, tableStartY + 5);

  for (let i = 0; i < rightTableRows; i++) {
    const rowY = tableStartY + headerHeight + (i * rowHeight);
    drawBox(rightTableX, rowY, tableWidth, rowHeight);
    doc.setFont('helvetica', 'normal');
    
    const itemIndex = i + itemsPerTable;
    if (data.items && data.items[itemIndex]) {
      const item = data.items[itemIndex];
      doc.text((itemIndex + 1).toString(), rightTableX + 2, rowY + 4);
      const commodityLines = doc.splitTextToSize(item.commodity || '', tableWidth - 25);
      doc.text(commodityLines[0] || '', rightTableX + 12, rowY + 4);
      doc.text(item.qty.toString(), rightTableX + tableWidth - 15, rowY + 4);
    } else {
      doc.text((itemIndex + 1).toString(), rightTableX + 2, rowY + 4);
    }
  }

  const maxRows = Math.max(leftTableRows, rightTableRows, 1);
  yPos = tableStartY + headerHeight + (maxRows * rowHeight) + 10;

  // Important Declaration
  yPos += 5;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 128, 0);
  doc.text('Important Declaration', margin, yPos);
  yPos += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  const declarationText = data.declarationText || 'By proceeding with this shipment, I declare that the contents of my shipment do not contain any prohibited, illegal, or restricted items under international or local laws. I fully understand that shipping illegal goods constitutes a criminal offense and is punishable by law. I acknowledge that KNEX Delivery Services acts solely as a carrier and shall not be held responsible for the nature, condition, or contents of the shipment.';
  const declarationLines = doc.splitTextToSize(declarationText, pageWidth - (margin * 2));
  declarationLines.forEach((line) => {
    doc.text(line, margin, yPos);
    yPos += 4;
  });
  yPos += 6;

  // ============================================
  // PAGE 2: INFORMATION SECTIONS
  // ============================================
  addNewPage();
  
  yPos = margin + 10;

  // Dropping Point (for PH to UAE)
  if (isPhToUae) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 128, 0);
    doc.text('DROPPING POINT', margin, yPos);
    yPos += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text('ADDRESS: #81 Dr. A. Santos Ave., Brgy. San Antonio, Parañaque City 1700', margin, yPos);
    yPos += 6;
    doc.text('NEAREST LANDMARK: ORIGINAL PARIS AND INFRONT OF LOYOLA MEMORIAL PARK', margin, yPos);
    yPos += 6;
    doc.text('CONTACT PERSON: CARMEN SUBA', margin, yPos);
    yPos += 6;
    doc.text('CONTACT NO.: +63 938 490 2564', margin, yPos);
    yPos += 12;
  }

  // Loading Schedules (for PH to UAE)
  if (isPhToUae) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 128, 0);
    doc.text('LOADING SCHEDULES', margin, yPos);
    yPos += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text('TUESDAY LOADING: (RECEIVING TIME: 10:00 AM to 8:00 PM)', margin, yPos);
    yPos += 6;
    doc.text('Friday Arrival (Saturday or Sunday Delivery)', margin, yPos);
    yPos += 6;
    doc.setFont('helvetica', 'bold');
    doc.text('Monday is our cut-off day!', margin, yPos);
    yPos += 10;

    doc.setFont('helvetica', 'normal');
    doc.text('FRIDAY LOADING: (RECEIVING TIME: 10:00 AM to 8:00 PM)', margin, yPos);
    yPos += 6;
    doc.text('Monday Arrival (Monday or Tuesday Delivery)', margin, yPos);
    yPos += 6;
    doc.setFont('helvetica', 'bold');
    doc.text('Thursday is our cut-off day!', margin, yPos);
    yPos += 12;
  }

  // Banned Items
  addBannedItemsSection();

  // ============================================
  // PAGE 3: ID IMAGES (2x2 Grid)
  // ============================================
  addNewPage();
  const page3Number = doc.getNumberOfPages();

  const imageMargin = 20;
  const imageSpacing = 15;
  const imageWidth = (pageWidth - (imageMargin * 2) - imageSpacing) / 2;
  const leftImageX = imageMargin;
  const rightImageX = imageMargin + imageWidth + imageSpacing;
  
  const topRowY = 30;
  const bottomRowY = topRowY + 100;
  const maxImageHeight = 90;

  // Top Row - Left: Emirates ID Front
  if (data.eidFrontImage) {
    await addImageToPDF(data.eidFrontImage, leftImageX, topRowY, imageWidth, maxImageHeight);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text('Emirates ID - Front', leftImageX, topRowY - 8);
  } else {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(128, 128, 128);
    doc.text('Emirates ID - Front (Not Provided)', leftImageX, topRowY - 8);
  }

  // Top Row - Right: Emirates ID Back
  if (data.eidBackImage) {
    await addImageToPDF(data.eidBackImage, rightImageX, topRowY, imageWidth, maxImageHeight);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text('Emirates ID - Back', rightImageX, topRowY - 8);
  } else {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(128, 128, 128);
    doc.text('Emirates ID - Back (Not Provided)', rightImageX, topRowY - 8);
  }

  // Bottom Row - Left: Philippines ID Front
  if (data.philippinesIdFront) {
    await addImageToPDF(data.philippinesIdFront, leftImageX, bottomRowY, imageWidth, maxImageHeight);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text('Philippines ID - Front', leftImageX, bottomRowY - 5);
  } else {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(128, 128, 128);
    doc.text('Philippines ID - Front (Not Provided)', leftImageX, bottomRowY - 5);
  }

  // Bottom Row - Right: Philippines ID Back
  if (data.philippinesIdBack) {
    await addImageToPDF(data.philippinesIdBack, rightImageX, bottomRowY, imageWidth, maxImageHeight);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text('Philippines ID - Back', rightImageX, bottomRowY - 5);
  } else {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(128, 128, 128);
    doc.text('Philippines ID - Back (Not Provided)', rightImageX, bottomRowY - 5);
  }

  // ============================================
  // PAGE 4: ADDITIONAL DOCUMENTS (only if documents exist)
  // ============================================
  // Check if additional documents exist (only for UAE_TO_PH and PH_TO_UAE)
  const hasAdditionalDocuments = data.confirmationForm || data.tradeLicense;
  
  // Only create additional documents page if at least one document exists
  if (hasAdditionalDocuments) {
    addNewPage();
    const page4Number = doc.getNumberOfPages();

    // Header
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 128, 0);
    doc.text('ADDITIONAL DOCUMENTS', margin, margin + 10);
    yPos = margin + 20;
    
    drawLine(yPos);
    yPos += 10;

    const additionalImageMargin = 20;
    const additionalImageSpacing = 15;
    const additionalImageWidth = (pageWidth - (additionalImageMargin * 2) - additionalImageSpacing) / 2;
    const additionalLeftImageX = additionalImageMargin;
    const additionalRightImageX = additionalImageMargin + additionalImageWidth + additionalImageSpacing;
    const additionalImageStartY = yPos + 10;
    const additionalMaxImageHeight = 90;

    // Top Row - Left: Confirmation Form
    if (data.confirmationForm) {
      await addImageToPDF(data.confirmationForm, additionalLeftImageX, additionalImageStartY, additionalImageWidth, additionalMaxImageHeight);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0, 0, 0);
      doc.text('Confirmation Form', additionalLeftImageX, additionalImageStartY - 8);
    } else {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(128, 128, 128);
      doc.text('Confirmation Form (Not Provided)', additionalLeftImageX, additionalImageStartY - 8);
    }

    // Top Row - Right: Trade License
    if (data.tradeLicense) {
      await addImageToPDF(data.tradeLicense, additionalRightImageX, additionalImageStartY, additionalImageWidth, additionalMaxImageHeight);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0, 0, 0);
      doc.text('Trade License', additionalRightImageX, additionalImageStartY - 8);
    } else {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(128, 128, 128);
      doc.text('Trade License (Not Provided)', additionalRightImageX, additionalImageStartY - 8);
    }
  }

  // ============================================
  // PAGE 5: SELFIE/FACE IMAGES (only if photos exist)
  // ============================================
  const customerPhotos = data.customerImages && data.customerImages.length > 0 
    ? data.customerImages 
    : (data.customerImage ? [data.customerImage] : []);
  
  // Only create customer photos page if photos are available
  if (customerPhotos.length > 0) {
    addNewPage();
    const page5Number = doc.getNumberOfPages();

    const page5ImageMargin = 20;
    const page5ImageSpacing = 15;
    const page5ImageWidth = (pageWidth - (page5ImageMargin * 2) - page5ImageSpacing) / 2;
    const page5LeftImageX = page5ImageMargin;
    const page5RightImageX = page5ImageMargin + page5ImageWidth + page5ImageSpacing;
    const page5ImageStartY = 40;
    const page5MaxImageHeight = (pageHeight - page5ImageStartY - margin) * 0.8;

    if (customerPhotos.length === 1) {
      const centeredX = (pageWidth - page5ImageWidth) / 2;
      await addImageToPDF(customerPhotos[0], centeredX, page5ImageStartY, page5ImageWidth, page5MaxImageHeight);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('Customer Photo', centeredX, page5ImageStartY - 8);
    } else {
      if (customerPhotos[0]) {
        await addImageToPDF(customerPhotos[0], page5LeftImageX, page5ImageStartY, page5ImageWidth, page5MaxImageHeight);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.text('Customer Photo - 1', page5LeftImageX, page5ImageStartY - 8);
      }

      if (customerPhotos.length > 1 && customerPhotos[1]) {
        await addImageToPDF(customerPhotos[1], page5RightImageX, page5ImageStartY, page5ImageWidth, page5MaxImageHeight);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.text('Customer Photo - 2', page5RightImageX, page5ImageStartY - 8);
      }
    }
  }

  // Add footer to all pages
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    const footerY = pageHeight - margin - 15;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.text('Rocky Warehouse Warehouse #19, 11th Street, Al Qusais Industrial Area 1, Dubai, 0000 United Arab Emirates', pageWidth / 2, footerY, { align: 'center' });
    doc.text('+971559738713', pageWidth / 2, footerY + 5, { align: 'center' });
  }

  // Return PDF as buffer
  return doc.output('arraybuffer');
}

module.exports = { generateBookingPDF };

