import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios"; // For Pinata API
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Configure Puppeteer to avoid detection
puppeteer.use(StealthPlugin());

// Validate Pinata API Keys
if (!process.env.PINATA_API_KEY || !process.env.PINATA_SECRET_API_KEY) {
  console.error("❌ Missing Pinata API credentials. Check your .env file.");
  process.exit(1);
}

// Function to store JSON data on Pinata
async function storeDataOnIPFS(data) {
  try {
    const jsonData = JSON.stringify(data);

    const response = await axios.post(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      {
        pinataContent: data,
        pinataMetadata: { name: "FiverrProfileData" },
      },
      {
        headers: {
          "Content-Type": "application/json",
          pinata_api_key: process.env.PINATA_API_KEY,
          pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY,
        },
      }
    );

    return response.data.IpfsHash; // CID of the uploaded data
  } catch (error) {
    console.error("❌ Pinata Upload Error:", error.response?.data || error.message);
    return null;
  }
}

// Function to scrape Fiverr profile
async function scrapeFiverrProfile(profileUrl) {
  console.log(`🔵 Scraping: ${profileUrl}`);
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    console.log("✅ Puppeteer launched successfully");

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
    );
    page.setDefaultNavigationTimeout(60000);

    console.log("🔵 Navigating to:", profileUrl);
    await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // Fix: Using setTimeout instead of page.waitForTimeout()
    await new Promise((r) => setTimeout(r, 5000));

    // Debugging Screenshot
    await page.screenshot({ path: "fiverr_debug.png" });
    console.log("📸 Screenshot saved as fiverr_debug.png");

    const domData = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText.trim() : "N/A";
      };

      const publicName = getText("h1[aria-label='Public Name']");
      const username = getText("div[aria-label='Username']");
      const gigTitle = getText("p[role='heading'][aria-level='3']");
      let reviewsCount = "N/A";

      const reviewsElement = document.querySelector("#Reviews h2.text-display-7");
      if (reviewsElement) {
        reviewsCount = reviewsElement.innerText.split("Reviews")[0].trim();
      }

      let skills = [];
      const skillsList = document.querySelectorAll('ul[aria-label="Skills List"] li a');
      if (skillsList.length > 0) {
        skills = Array.from(skillsList).map((a) => a.innerText.trim());
      }

      let gigs = [];
      const servicesSection = document.querySelector("#Services");
      if (servicesSection) {
        const gigContainer = servicesSection.querySelector(".gig_listings-package.listing-container.grid-view");
        if (gigContainer) {
          const gigElements = gigContainer.querySelectorAll(".gig-card-layout");
          gigs = Array.from(gigElements).map((el) => {
            const titleEl = el.querySelector("h4, h3, p");
            const title = titleEl ? titleEl.innerText.trim() : "N/A";
            const linkEl = el.querySelector("a");
            const link = linkEl ? linkEl.href : "N/A";
            return { title, link };
          });
        }
      }

      let projects = [];
      const projectElements = document.querySelectorAll(".project-item");
      projects = Array.from(projectElements).map((el) => {
        const titleEl = el.querySelector(".project-title");
        const title = titleEl ? titleEl.innerText.trim() : "N/A";
        const imageEl = el.querySelector("img");
        const image = imageEl ? imageEl.src : "N/A";
        return { title, image };
      });

      return { publicName, username, gigTitle, reviewsCount, skills, gigs, projects };
    });

    console.log("✅ Scraped Data:", domData);
    return domData;
  } catch (error) {
    console.error("❌ Scraping Error:", error);
    return null;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🛑 Browser closed.");
    }
  }
}

// API Route to scrape Fiverr and store data on IPFS
app.post("/scrape", async (req, res) => {
  const { profileUrl } = req.body;

  if (!profileUrl) {
    return res.status(400).json({ error: "❌ Profile URL is required" });
  }

  const scrapedData = await scrapeFiverrProfile(profileUrl);
  if (!scrapedData) {
    return res.status(500).json({ error: "❌ Failed to scrape Fiverr profile" });
  }

  const ipfsCID = await storeDataOnIPFS(scrapedData);
  if (!ipfsCID) {
    return res.status(500).json({ error: "❌ Failed to upload data to IPFS" });
  }

  return res.json({ success: true, cid: ipfsCID, ipfsUrl: `https://gateway.pinata.cloud/ipfs/${ipfsCID}` });
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
