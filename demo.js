import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios"; // For Pinata API
import dotenv from "dotenv";
import crypto from "crypto"; // For hashing
import { ethers, JsonRpcProvider } from "ethers"; // For blockchain integration

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

// Validate blockchain configuration
if (!process.env.CONTRACT_ADDRESS || !process.env.RPC_URL || !process.env.PRIVATE_KEY) {
  console.error("❌ Missing blockchain configuration. Check your .env file.");
  process.exit(1);
}

// In-memory storage for metadata hashes (use a database in production)
const uploadedMetadata = new Map(); // { hash: CID }

// --------------------------------------
// Helper Functions
// --------------------------------------

// Generate SHA-256 hash of JSON data
function generateHash(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

// Function to store JSON data on Pinata (with duplicate prevention)
async function storeDataOnIPFS(data, metadataName) {
  const dataHash = generateHash(data);

  // Check if the metadata already exists
  if (uploadedMetadata.has(dataHash)) {
    console.log(`⚠️ Duplicate detected (${metadataName}). Returning existing CID.`);
    return uploadedMetadata.get(dataHash); // Return existing CID
  }

  try {
    const response = await axios.post(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      {
        pinataContent: data,
        pinataMetadata: { name: metadataName },
      },
      {
        headers: {
          "Content-Type": "application/json",
          pinata_api_key: process.env.PINATA_API_KEY,
          pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY,
        },
      }
    );

    const cid = response.data.IpfsHash;
    uploadedMetadata.set(dataHash, cid); // Store the new hash-CID pair

    return cid; // Return new CID
  } catch (error) {
    console.error(`❌ Pinata Upload Error (${metadataName}):`, error.response?.data || error.message);
    return null;
  }
}

// Function to scrape a Fiverr profile
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

    // Wait a few seconds for dynamic content to load
    await new Promise((r) => setTimeout(r, 5000));

    // Save a debugging screenshot (optional)
    await page.screenshot({ path: "fiverr_debug.png" });
    console.log("📸 Screenshot saved as fiverr_debug.png");

    // Extract data from the DOM
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

// --------------------------------------
// Blockchain & Contract Setup
// --------------------------------------

// SBT contract ABI (ensure it matches your deployed contract)
const sbtABI = [
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "address",
				"name": "user",
				"type": "address"
			},
			{
				"indexed": false,
				"internalType": "string",
				"name": "did",
				"type": "string"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "timestamp",
				"type": "uint256"
			}
		],
		"name": "DIDRegistered",
		"type": "event"
	},
	{
		"inputs": [
			{
				"internalType": "string",
				"name": "",
				"type": "string"
			}
		],
		"name": "didRecords",
		"outputs": [
			{
				"internalType": "string",
				"name": "did",
				"type": "string"
			},
			{
				"internalType": "address",
				"name": "userWallet",
				"type": "address"
			},
			{
				"internalType": "string",
				"name": "uniqueIdentifierHash",
				"type": "string"
			},
			{
				"internalType": "uint256",
				"name": "timestamp",
				"type": "uint256"
			},
			{
				"internalType": "string",
				"name": "dateOfBirth",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "name",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "github",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "fiverr",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "upwork",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "additional",
				"type": "string"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "userWallet",
				"type": "address"
			},
			{
				"internalType": "string",
				"name": "did",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "uniqueIdentifierHash",
				"type": "string"
			},
			{
				"internalType": "uint256",
				"name": "timestamp",
				"type": "uint256"
			},
			{
				"internalType": "string",
				"name": "dateOfBirth",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "name",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "github",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "fiverr",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "upwork",
				"type": "string"
			},
			{
				"internalType": "string",
				"name": "additional",
				"type": "string"
			}
		],
		"name": "registerDID",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"name": "userToDID",
		"outputs": [
			{
				"internalType": "string",
				"name": "",
				"type": "string"
			}
		],
		"stateMutability": "view",
		"type": "function"
	}
];

const sbtAddress = process.env.CONTRACT_ADDRESS;
const provider = new JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const sbtContract = new ethers.Contract(sbtAddress, sbtABI, signer);

// --------------------------------------
// API Endpoints
// --------------------------------------

// Register DID via smart contract
app.post('/api/register', async (req, res) => {
  try {
    const { wallet, did, uniqueIdentifierHash, timestamp, dateOfBirth, name, github, fiverr, upwork, additional } = req.body;
    const tx = await sbtContract.registerDID(wallet, did, uniqueIdentifierHash, timestamp, dateOfBirth, name, github, fiverr, upwork, additional);
    await tx.wait();
    res.json({ success: true, txHash: tx.hash });
  } catch (error) {
    console.error('Error in /api/register:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get profile data via wallet address
app.get('/api/profile/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    const did = awaitsbtContract.userToDID(wallet);
    if (!did || did === "") {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }
    const record = await sbtContract.didRecords(did);
    res.json({ success: true, profile: record });
  } catch (error) {
    console.error('Error in /api/profile/:wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Scrape Fiverr profile, upload to IPFS, and mint SBT
app.post("/scrape", async (req, res) => {
  // The rest of the "scrape" endpoint logic from your original code
});

// --------------------------------------
// Start the Express Server
// --------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});



// import express from "express";
// import cors from "cors";
// import bodyParser from "body-parser";
// import puppeteer from "puppeteer-extra";
// import StealthPlugin from "puppeteer-extra-plugin-stealth";
// import axios from "axios"; // For Pinata API
// import dotenv from "dotenv";
// import crypto from "crypto"; // For hashing

// // Load environment variables
// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 5000;

// // Middleware
// app.use(cors());
// app.use(bodyParser.json());

// // Configure Puppeteer to avoid detection
// puppeteer.use(StealthPlugin());

// // Validate Pinata API Keys
// if (!process.env.PINATA_API_KEY || !process.env.PINATA_SECRET_API_KEY) {
//   console.error("❌ Missing Pinata API credentials. Check your .env file.");
//   process.exit(1);
// }

// // In-memory storage for metadata hashes (Use a database in production)
// const uploadedMetadata = new Map(); // { hash: CID }

// // Function to generate SHA-256 hash of JSON data
// function generateHash(data) {
//   return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
// }

// // Function to store JSON data on Pinata (with duplicate prevention)
// async function storeDataOnIPFS(data, metadataName) {
//   const dataHash = generateHash(data);

//   // Check if the metadata already exists
//   if (uploadedMetadata.has(dataHash)) {
//     console.log(`⚠️ Duplicate detected (${metadataName}). Returning existing CID.`);
//     return uploadedMetadata.get(dataHash); // Return existing CID
//   }

//   try {
//     const response = await axios.post(
//       "https://api.pinata.cloud/pinning/pinJSONToIPFS",
//       {
//         pinataContent: data,
//         pinataMetadata: { name: metadataName },
//       },
//       {
//         headers: {
//           "Content-Type": "application/json",
//           pinata_api_key: process.env.PINATA_API_KEY,
//           pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY,
//         },
//       }
//     );

//     const cid = response.data.IpfsHash;
//     uploadedMetadata.set(dataHash, cid); // Store the new hash-CID pair

//     return cid; // Return new CID
//   } catch (error) {
//     console.error(`❌ Pinata Upload Error (${metadataName}):`, error.response?.data || error.message);
//     return null;
//   }
// }

// // Function to scrape Fiverr profile
// async function scrapeFiverrProfile(profileUrl) {
//   console.log(`🔵 Scraping: ${profileUrl}`);
//   let browser;

//   try {
//     browser = await puppeteer.launch({
//       headless: false,
//       args: ["--no-sandbox", "--disable-setuid-sandbox"],
//     });

//     console.log("✅ Puppeteer launched successfully");

//     const page = await browser.newPage();
//     await page.setUserAgent(
//       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
//     );
//     page.setDefaultNavigationTimeout(60000);

//     console.log("🔵 Navigating to:", profileUrl);
//     await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 });

//     // Fix: Using setTimeout instead of page.waitForTimeout()
//     await new Promise((r) => setTimeout(r, 5000));

//     // Debugging Screenshot
//     await page.screenshot({ path: "fiverr_debug.png" });
//     console.log("📸 Screenshot saved as fiverr_debug.png");

//     const domData = await page.evaluate(() => {
//       const getText = (selector) => {
//         const el = document.querySelector(selector);
//         return el ? el.innerText.trim() : "N/A";
//       };

//       const publicName = getText("h1[aria-label='Public Name']");
//       const username = getText("div[aria-label='Username']");
//       const gigTitle = getText("p[role='heading'][aria-level='3']");
//       let reviewsCount = "N/A";

//       const reviewsElement = document.querySelector("#Reviews h2.text-display-7");
//       if (reviewsElement) {
//         reviewsCount = reviewsElement.innerText.split("Reviews")[0].trim();
//       }

//       let skills = [];
//       const skillsList = document.querySelectorAll('ul[aria-label="Skills List"] li a');
//       if (skillsList.length > 0) {
//         skills = Array.from(skillsList).map((a) => a.innerText.trim());
//       }

//       let gigs = [];
//       const servicesSection = document.querySelector("#Services");
//       if (servicesSection) {
//         const gigContainer = servicesSection.querySelector(".gig_listings-package.listing-container.grid-view");
//         if (gigContainer) {
//           const gigElements = gigContainer.querySelectorAll(".gig-card-layout");
//           gigs = Array.from(gigElements).map((el) => {
//             const titleEl = el.querySelector("h4, h3, p");
//             const title = titleEl ? titleEl.innerText.trim() : "N/A";
//             const linkEl = el.querySelector("a");
//             const link = linkEl ? linkEl.href : "N/A";
//             return { title, link };
//           });
//         }
//       }

//       let projects = [];
//       const projectElements = document.querySelectorAll(".project-item");
//       projects = Array.from(projectElements).map((el) => {
//         const titleEl = el.querySelector(".project-title");
//         const title = titleEl ? titleEl.innerText.trim() : "N/A";
//         const imageEl = el.querySelector("img");
//         const image = imageEl ? imageEl.src : "N/A";
//         return { title, image };
//       });

//       return { publicName, username, gigTitle, reviewsCount, skills, gigs, projects };
//     });

//     console.log("✅ Scraped Data:", domData);
//     return domData;
//   } catch (error) {
//     console.error("❌ Scraping Error:", error);
//     return null;
//   } finally {
//     if (browser) {
//       await browser.close();
//       console.log("🛑 Browser closed.");
//     }
//   }
// }

// // API Route to scrape Fiverr and store data on IPFS
// app.post("/scrape", async (req, res) => {
//   const { profileUrl } = req.body;

//   if (!profileUrl) {
//     return res.status(400).json({ error: "❌ Profile URL is required" });
//   }

//   const scrapedData = await scrapeFiverrProfile(profileUrl);
//   if (!scrapedData) {
//     return res.status(500).json({ error: "❌ Failed to scrape Fiverr profile" });
//   }

//   // Upload each gig separately to IPFS (with duplicate prevention)
//   let gigCIDs = [];
//   for (const gig of scrapedData.gigs) {
//     const gigCID = await storeDataOnIPFS(gig, `Gig-${gig.title}`);
//     if (gigCID) {
//       gigCIDs.push({ gigTitle: gig.title, cid: gigCID, ipfsUrl: `https://gateway.pinata.cloud/ipfs/${gigCID}` });
//     }
//   }

//   // Store main profile data with gig CIDs
//   const profileData = {
//     publicName: scrapedData.publicName,
//     username: scrapedData.username,
//     gigTitle: scrapedData.gigTitle,
//     reviewsCount: scrapedData.reviewsCount,
//     skills: scrapedData.skills,
//     projects: scrapedData.projects,
//     gigs: gigCIDs, // Store only the CIDs here
//   };

//   const profileCID = await storeDataOnIPFS(profileData, "FiverrProfile");
//   if (!profileCID) {
//     return res.status(500).json({ error: "❌ Failed to upload profile data to IPFS" });
//   }

//   return res.json({ 
//     success: true, 
//     profileCID, 
//     profileIpfsUrl: `https://gateway.pinata.cloud/ipfs/${profileCID}`,
//     gigs: gigCIDs 
//   });
// });

// // Start the Express server
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on http://localhost:${PORT}`);
// });



