const quais = require("quais");
const dotenv = require("dotenv");

dotenv.config();

// Array of addresses to check
const ADDRESSES_TO_CHECK = ["0x007198f7E77dD3321ed2C5Be68176598c3b5e77e"];

// Configuration
const VESTING_CONTRACT_ADDRESS = "0x0045edcE84e8E85e1E4861f082e5F5A0a50A7317";
const MAX_RETRIES = 10;
const RPC_RETRY_DELAY = 2000; // 2 seconds between retries

// Vesting contract ABI (just the functions we need)
const vestingContractABI = [
  "function beneficiaries(address) external view returns (uint256 totalAmount, uint256 releasedAmount, uint64 startBlock, uint64 durationInBlocks, uint64 cliffBlock)",
];

// Get provider and contract
const { RPC_URL } = process.env;
const provider = new quais.JsonRpcProvider(RPC_URL);
const vestingContract = new quais.Contract(
  VESTING_CONTRACT_ADDRESS,
  vestingContractABI,
  provider
);

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

// Function to get vesting schedule details for an address
async function getVestingScheduleDetails(address) {
  try {
    // Wrap the contract call with retry logic
    const schedule = await withRetry(() =>
      vestingContract.beneficiaries(address)
    );

    if (schedule.totalAmount > 0) {
      return {
        exists: true,
        totalAmount: quais.formatQuai(schedule.totalAmount),
        releasedAmount: quais.formatQuai(schedule.releasedAmount),
        startBlock: Number(schedule.startBlock),
        durationInBlocks: Number(schedule.durationInBlocks),
        cliffBlock: Number(schedule.cliffBlock),
        endBlock:
          Number(schedule.startBlock) + Number(schedule.durationInBlocks),
        vestedPercentage:
          schedule.totalAmount > 0
            ? (
                (Number(schedule.releasedAmount) * 100) /
                Number(schedule.totalAmount)
              ).toFixed(2) + "%"
            : "0%",
      };
    } else {
      return { exists: false };
    }
  } catch (error) {
    logMessage(
      `Error checking vesting schedule for ${address}: ${error.message}`
    );
    return { exists: false, error: error.message };
  }
}

// Function to log messages
function logMessage(message) {
  console.log(message);
}

// Main function to check vesting schedules
async function checkVestingSchedules(addresses) {
  if (!addresses || addresses.length === 0) {
    logMessage("No addresses provided to check");
    return [];
  }

  logMessage(`Checking vesting schedules for ${addresses.length} addresses...`);

  const results = [];

  for (const address of addresses) {
    logMessage(`Checking address: ${address}`);

    if (!quais.isQuaiAddress(address)) {
      logMessage(`Invalid Quai address: ${address}`);
      results.push({ address, valid: false, message: "Invalid Quai address" });
      continue;
    }

    try {
      const details = await getVestingScheduleDetails(address);

      if (details.exists) {
        logMessage(`✅ Vesting schedule found for ${address}:`);
        logMessage(`   Total Amount: ${details.totalAmount} QUAI`);
        logMessage(
          `   Released Amount: ${details.releasedAmount} QUAI (${details.vestedPercentage})`
        );
        logMessage(`   Start Block: ${details.startBlock}`);
        logMessage(`   Cliff Block: ${details.cliffBlock}`);
        logMessage(`   Duration: ${details.durationInBlocks} blocks`);
        logMessage(`   End Block: ${details.endBlock}`);

        results.push({
          address,
          valid: true,
          exists: true,
          details,
        });
      } else {
        logMessage(`❌ No vesting schedule found for ${address}`);
        results.push({
          address,
          valid: true,
          exists: false,
        });
      }
    } catch (error) {
      logMessage(`Error checking ${address}: ${error.message}`);
      results.push({
        address,
        valid: true,
        exists: false,
        error: error.message,
      });
    }
  }

  logMessage(`Completed checking ${addresses.length} addresses`);
  return results;
}

// Process command line arguments
async function main() {
  try {
    const results = await checkVestingSchedules(ADDRESSES_TO_CHECK);
    console.log("\nSummary:");
    console.log("-----------------------------------------");

    for (const result of results) {
      if (!result.valid) {
        console.log(`${result.address}: Invalid address`);
      } else if (result.error) {
        console.log(`${result.address}: Error - ${result.error}`);
      } else if (result.exists) {
        console.log(
          `${result.address}: ✅ Has vesting schedule - ${result.details.totalAmount} QUAI (${result.details.vestedPercentage} vested)`
        );
      } else {
        console.log(`${result.address}: ❌ No vesting schedule`);
      }
    }

    console.log("-----------------------------------------");
  } catch (error) {
    logMessage(`Error in main execution: ${error.message}`);
  }
}

// Run the script
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });
