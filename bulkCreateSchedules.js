const fs = require("fs");
const Papa = require("papaparse");
const quais = require("quais");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

// Create directories if they don't exist
const dataDir = path.join(__dirname, "data");
const recordsDir = path.join(__dirname, "records");
const logsDir = path.join(__dirname, "logs");

// Ensure directories exist
[dataDir, recordsDir, logsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

// Optional start block offset in days (set to null to use current block)
const START_BLOCK_OFFSET_DAYS = 3; // If set, vesting will start this many days from current block

// Updated for vesting distribution
const VESTING_ITERATION = 3;
const VESTING_SOURCE_FILE = path.join(
  dataDir,
  `vesting_amounts${VESTING_ITERATION}.csv`
);
const VESTING_RECORD_FILE = path.join(
  recordsDir,
  `vesting_records_mainnet${VESTING_ITERATION}.csv`
);
const VESTING_LOG_FILE = path.join(
  logsDir,
  `vesting_mainnet${VESTING_ITERATION}.log`
);
const VESTING_CONTRACT_ADDRESS = "0x0045edcE84e8E85e1E4861f082e5F5A0a50A7317";
const BATCH_SIZE = 10; // Process 10 beneficiaries at a time
const MAX_RETRIES = 10;
const RPC_RETRY_DELAY = 2000; // 2 seconds between retries
const TX_TIMEOUT_MS = 120000; // 2 minutes

// Vesting duration parameters (assuming 5 second block time)
const BLOCKS_PER_DAY = 17280; // 24 * 60 * 60 / 5
const VESTING_DURATION_DAYS = 730; // 2 years (365 * 2)
const CLIFF_PERIOD_DAYS = 180; // 6 months
const VESTING_DURATION_BLOCKS = VESTING_DURATION_DAYS * BLOCKS_PER_DAY;
const CLIFF_PERIOD_BLOCKS = CLIFF_PERIOD_DAYS * BLOCKS_PER_DAY;

// Vesting contract ABI (just the functions we need)
const vestingContractABI = [
  "function addBeneficiaries(tuple(address beneficiary, uint256 totalAmount, uint64 startBlock, uint64 durationInBlocks, uint64 cliffBlock)[] calldata schedules) external",
  "function beneficiaries(address) external view returns (uint256 totalAmount, uint256 releasedAmount, uint64 startBlock, uint64 durationInBlocks, uint64 cliffBlock)",
];

// Read vesting_amounts.csv
let data = [];
if (fs.existsSync(VESTING_SOURCE_FILE)) {
  const vestingData = fs.readFileSync(VESTING_SOURCE_FILE, "utf8");
  data = Papa.parse(vestingData, { header: true }).data;

  // ensure data has no duplicate wallets
  const uniqueWallets = new Set(data.map((row) => row.wallet));
  if (uniqueWallets.size !== data.length) {
    console.error(`Error: Duplicate wallets found in ${VESTING_SOURCE_FILE}`);
    process.exit(1);
  }
} else {
  console.error(`Error: ${VESTING_SOURCE_FILE} not found`);
  process.exit(1);
}

const { RPC_URL, PRIVATE_KEY } = process.env;
const provider = new quais.JsonRpcProvider(RPC_URL, undefined, {
  batchMaxCount: 1,
});
const wallet = new quais.Wallet(PRIVATE_KEY, provider);
const vestingContract = new quais.Contract(
  VESTING_CONTRACT_ADDRESS,
  vestingContractABI,
  wallet
);

let lastTxHash = null;
let isRestarting = false;

// Add a transaction cache to track pending transactions
const pendingTransactions = new Map();
const processedWallets = new Set();

// Generic retry function for RPC calls
async function withRetry(
  fn,
  maxRetries = MAX_RETRIES,
  retryDelay = RPC_RETRY_DELAY
) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Log the error but continue retrying
      logMessage(
        `RPC call failed (Attempt ${attempt}/${maxRetries}): ${error.message}`
      );

      // Don't wait on the last attempt
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  // If we've exhausted all retries, throw the last error
  throw new Error(`Failed after ${maxRetries} attempts: ${lastError.message}`);
}

// Function to check if a wallet already has a vesting schedule in the contract
async function checkExistingVestingSchedule(address) {
  try {
    // Wrap the contract call with retry logic
    const schedule = await withRetry(() =>
      vestingContract.beneficiaries(address)
    );
    // If totalAmount is greater than 0, the address already has a vesting schedule
    return schedule.totalAmount > 0;
  } catch (error) {
    logMessage(
      `Error checking vesting schedule for ${address}: ${error.message}`
    );
    return false; // Assume no schedule if there's an error
  }
}

// Function to check if a wallet already has a successful transaction
function checkForSuccessfulTransaction(wallet) {
  if (!fs.existsSync(VESTING_RECORD_FILE)) {
    return null;
  }

  try {
    const recordData = fs.readFileSync(VESTING_RECORD_FILE, "utf8");
    const records = Papa.parse(recordData, { header: true }).data;

    // Find the most recent successful transaction for this wallet
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (
        record.wallet === wallet &&
        record.status === "success" &&
        record.tx_hash
      ) {
        return record.tx_hash;
      }
    }

    return null;
  } catch (error) {
    logMessage(`Error checking for existing transactions: ${error.message}`);
    return null;
  }
}

// Load any pending transactions from the last run
function loadPendingTransactions() {
  if (!fs.existsSync(VESTING_RECORD_FILE)) {
    return;
  }

  try {
    const recordData = fs.readFileSync(VESTING_RECORD_FILE, "utf8");
    const records = Papa.parse(recordData, { header: true }).data;

    // Find transactions marked as pending or with missing status
    for (const record of records) {
      if (
        record.wallet &&
        record.tx_hash &&
        (record.status === "pending" || !record.status)
      ) {
        pendingTransactions.set(record.wallet, record.tx_hash);
        logMessage(
          `Loaded pending transaction ${record.tx_hash} for wallet ${record.wallet}`
        );
      }

      // Track all successfully processed wallets
      if (record.wallet && record.status === "success") {
        processedWallets.add(record.wallet);
        logMessage(`Loaded successfully processed wallet: ${record.wallet}`);
      }
    }
  } catch (error) {
    logMessage(`Error loading pending transactions: ${error.message}`);
  }
}

// Process a batch of beneficiaries and add them to the vesting contract
async function processBeneficiaryBatch(beneficiaries) {
  if (beneficiaries.length === 0) {
    return;
  }

  // Get current block number for vesting start with retry
  const currentBlock = await withRetry(() => provider.getBlockNumber());

  // Calculate start block based on offset in days
  const startBlock =
    START_BLOCK_OFFSET_DAYS !== null
      ? currentBlock + START_BLOCK_OFFSET_DAYS * BLOCKS_PER_DAY
      : currentBlock;
  const cliffBlock = startBlock + CLIFF_PERIOD_BLOCKS;

  // Format beneficiaries for contract call
  const schedules = beneficiaries.map(({ wallet, amount }) => ({
    beneficiary: wallet,
    totalAmount: quais.getBigInt(amount),
    startBlock: startBlock,
    durationInBlocks: VESTING_DURATION_BLOCKS,
    cliffBlock: cliffBlock,
  }));

  logMessage(
    `----- Adding batch of ${beneficiaries.length} beneficiaries to vesting contract -----`
  );
  logMessage(
    `Start block: ${startBlock}, Cliff block: ${cliffBlock}, Duration: ${VESTING_DURATION_BLOCKS} blocks`
  );
  if (START_BLOCK_OFFSET_DAYS !== null) {
    logMessage(
      `Start block offset: ${START_BLOCK_OFFSET_DAYS} days (${
        START_BLOCK_OFFSET_DAYS * BLOCKS_PER_DAY
      } blocks)`
    );
  }

  let retryCount = 0;
  let status = "failed";
  let txHash = null;

  while (retryCount < MAX_RETRIES) {
    try {
      // Using the built-in retry mechanism for addBeneficiaries as it has special handling
      const tx = await vestingContract.addBeneficiaries(schedules);
      txHash = tx.hash;
      lastTxHash = txHash;

      // Track all beneficiaries in this batch as having pending transactions
      for (const { wallet } of beneficiaries) {
        pendingTransactions.set(wallet, txHash);
      }

      try {
        // Use Promise.race to add a timeout
        await Promise.race([
          tx.wait(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Transaction wait timeout")),
              TX_TIMEOUT_MS
            )
          ),
        ]);
        // Log transaction mined details
        logMessage(`Batch transaction included in block: ${txHash}`);
      } catch (error) {
        logMessage(
          `Error waiting for transaction ${txHash} to be mined: ${error.message}. ` +
            "Waiting for 10 seconds before retrying..."
        );
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      // Record transaction for each beneficiary in the batch
      for (const { wallet, amount } of beneficiaries) {
        const logData = `${wallet},${amount},${txHash},success,${startBlock},${cliffBlock},${VESTING_DURATION_BLOCKS},${
          startBlock + VESTING_DURATION_BLOCKS
        }\n`;
        fs.appendFileSync(VESTING_RECORD_FILE, logData);

        // Mark as processed
        processedWallets.add(wallet);
        pendingTransactions.delete(wallet);
      }

      logMessage(`Batch transaction recorded in ${VESTING_RECORD_FILE}`);
      status = "success";
      break;
    } catch (error) {
      retryCount++;
      logMessage(
        `Error adding batch to vesting contract (Attempt ${retryCount}/${MAX_RETRIES}): ${error.message}`
      );

      if (retryCount === MAX_RETRIES) {
        // Record failed transaction for each beneficiary
        for (const { wallet, amount } of beneficiaries) {
          const logData = `${wallet},${amount},,failed,${startBlock},${cliffBlock},${VESTING_DURATION_BLOCKS},${
            startBlock + VESTING_DURATION_BLOCKS
          }\n`;
          fs.appendFileSync(VESTING_RECORD_FILE, logData);

          // Remove from pending
          pendingTransactions.delete(wallet);
        }
        logMessage(
          `Failed batch transaction recorded in ${VESTING_RECORD_FILE}`
        );
      } else {
        // Wait for a short delay before retrying
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // Log final status
  logMessage(`Batch transaction status: ${status}`);
  return status === "success";
}

// Function to log messages to the log file
function logMessage(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(VESTING_LOG_FILE, logEntry);
  console.log(`${timestamp}: ${message}`);
}

async function main() {
  // Prevent multiple instances of main running simultaneously
  if (global.isMainRunning) {
    logMessage("main() is already running. Skipping duplicate invocation.");
    return;
  }
  global.isMainRunning = true;

  try {
    // Create vesting_records.csv with headers if it doesn't exist
    if (!fs.existsSync(VESTING_RECORD_FILE)) {
      fs.writeFileSync(
        VESTING_RECORD_FILE,
        "wallet,amount,tx_hash,status,start_block,cliff_block,duration_blocks,end_block\n"
      );
    }

    // Load any pending transactions from previous runs
    loadPendingTransactions();

    // Read the last processed wallet from VESTING_RECORD_FILE
    let lastProcessedWallet = null;
    let lastProcessedValue = null;
    let lastProcessedTxDetails = null;

    logMessage("Checking for previously processed transactions...");
    if (fs.existsSync(VESTING_RECORD_FILE)) {
      const recordData = fs.readFileSync(VESTING_RECORD_FILE, "utf8");
      const records = Papa.parse(recordData, { header: true }).data;
      logMessage(`Found ${records.length} records in ${VESTING_RECORD_FILE}`);

      if (records.length > 0) {
        // Filter out empty rows that might come from CSV parsing
        const validRecords = records.filter(
          (record) => record.wallet && record.wallet.trim() !== ""
        );

        if (validRecords.length > 0) {
          lastProcessedTxDetails = validRecords[validRecords.length - 1];
          lastProcessedWallet = lastProcessedTxDetails.wallet;
          lastProcessedValue = lastProcessedTxDetails.amount;
          logMessage(
            `Last processed wallet: ${lastProcessedWallet}, amount: ${lastProcessedValue}`
          );
        } else {
          logMessage("No valid records found in vesting file");
        }
      }
    }

    // Find the index of the last processed wallet in the distribution data
    let startIndex = 0;
    if (lastProcessedWallet) {
      const walletIndex = data.findIndex(
        (row) => row.wallet === lastProcessedWallet
      );

      if (walletIndex === -1) {
        logMessage(
          `WARNING: Last processed wallet ${lastProcessedWallet} not found in current vesting data!`
        );
        logMessage("Starting from the beginning of the vesting list");
      } else {
        startIndex = walletIndex + 1;
        logMessage(
          `Resuming vesting process from index ${startIndex} (after wallet: ${lastProcessedWallet})`
        );

        // Safety check - ensure we're not at the end of the data
        if (startIndex >= data.length) {
          logMessage(
            "All beneficiaries have already been processed. Nothing more to do."
          );
          return;
        }
      }
    } else {
      logMessage("No previous processing found. Starting from the beginning.");
    }

    // Process beneficiaries in batches of BATCH_SIZE
    logMessage(
      `Processing ${
        data.length - startIndex
      } wallets starting from index ${startIndex}`
    );

    let currentBatch = [];

    // First, check existing vesting schedules for all addresses
    for (let i = startIndex; i < data.length; i++) {
      const { wallet, total } = data[i];

      // Check if this wallet has already been processed successfully
      if (processedWallets.has(wallet)) {
        logMessage(
          `Wallet ${wallet} has already been processed successfully. Skipping.`
        );
        continue;
      }

      // Check if this wallet already has a successful transaction
      const existingSuccessfulTx = checkForSuccessfulTransaction(wallet);
      if (existingSuccessfulTx) {
        logMessage(
          `Wallet ${wallet} already has a successful transaction (${existingSuccessfulTx}). Skipping.`
        );
        processedWallets.add(wallet);
        continue;
      }

      // Check if wallet already has a vesting schedule in the contract
      const hasExistingSchedule = await checkExistingVestingSchedule(wallet);
      if (hasExistingSchedule) {
        logMessage(
          `Wallet ${wallet} already has a vesting schedule in the contract. Skipping.`
        );
        processedWallets.add(wallet);
        continue;
      }

      // Validate wallet and amount
      try {
        if (!quais.isQuaiAddress(wallet)) {
          logMessage(
            `##### Error: ${wallet} is not a valid Quai address. Skipping...`
          );
          continue;
        }

        const intValue = parseInt(total);
        if (isNaN(intValue)) {
          logMessage(
            `##### Error: ${total} is not a valid number. Skipping beneficiary ${wallet}...`
          );
          continue;
        }
      } catch (error) {
        logMessage(
          `##### Error validating beneficiary ${wallet}: ${error.message}`
        );
        continue;
      }

      // Add to current batch
      currentBatch.push({ wallet, amount: total });
      logMessage(
        `Added ${wallet} to current batch (${currentBatch.length}/${BATCH_SIZE})`
      );

      // Process batch when it reaches BATCH_SIZE
      if (currentBatch.length === BATCH_SIZE) {
        await processBeneficiaryBatch(currentBatch);
        currentBatch = []; // Reset batch
      }
    }

    // Process any remaining beneficiaries
    if (currentBatch.length > 0) {
      await processBeneficiaryBatch(currentBatch);
    }

    logMessage("Vesting beneficiary processing completed successfully");
  } catch (error) {
    logMessage(`Error in main execution: ${error.message}`);
    throw error;
  } finally {
    global.isMainRunning = false;
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  logMessage("Received SIGINT signal. Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logMessage("Received SIGTERM signal. Shutting down gracefully...");
  process.exit(0);
});

main()
  .then(() => {
    fs.appendFileSync(VESTING_LOG_FILE, "\n\nVesting process complete\n");
    process.exit(0);
  })
  .catch((error) => {
    fs.appendFileSync(VESTING_LOG_FILE, "\n\nError during vesting process:\n");
    fs.appendFileSync(VESTING_LOG_FILE, error.message);
    fs.appendFileSync(VESTING_LOG_FILE, "\n\n");

    // Rerun main after writing the logs, but avoid multiple restarts
    if (!isRestarting) {
      isRestarting = true;
      fs.appendFileSync(VESTING_LOG_FILE, "Restarting main...\n");
      main().finally(() => {
        isRestarting = false;
      });
    }
  });

process
  .on("unhandledRejection", (error) => {
    console.error("Unhandled rejection:", error);
    fs.appendFileSync(VESTING_LOG_FILE, "Unhandled rejection:\n");
    fs.appendFileSync(VESTING_LOG_FILE, error.message);
    fs.appendFileSync(VESTING_LOG_FILE, "\n");

    // Rerun main after writing the logs, but avoid multiple restarts
    if (!isRestarting) {
      isRestarting = true;
      fs.appendFileSync(VESTING_LOG_FILE, "Restarting main...\n");
      main().finally(() => {
        isRestarting = false;
      });
    }
  })
  .on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    fs.appendFileSync(VESTING_LOG_FILE, "Uncaught exception:\n");
    fs.appendFileSync(VESTING_LOG_FILE, error.message);
    fs.appendFileSync(VESTING_LOG_FILE, "\n");

    // Rerun main after writing the logs, but avoid multiple restarts
    if (!isRestarting) {
      isRestarting = true;
      fs.appendFileSync(VESTING_LOG_FILE, "Restarting main...\n");
      main().finally(() => {
        isRestarting = false;
      });
    }
  });
