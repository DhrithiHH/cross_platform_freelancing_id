import { create } from "ipfs-http-client";
import dotenv from "dotenv";

dotenv.config();

// Configure IPFS client using Infura credentials
const projectId = process.env.INFURA_PROJECT_ID;
const projectSecret = process.env.INFURA_PROJECT_SECRET;
const auth = "Basic " + Buffer.from(projectId + ":" + projectSecret).toString("base64");

const ipfs = create({
  host: "ipfs.infura.io",
  port: 5001,
  protocol: "https",
  headers: {
    authorization: auth,
  },
});

export async function storeDataOnIPFS(data) {
  try {
    const jsonData = JSON.stringify(data);
    const result = await ipfs.add(jsonData);
    return result.cid.toString();
  } catch (error) {
    console.error("Error uploading to IPFS:", error);
    return null;
  }
}
