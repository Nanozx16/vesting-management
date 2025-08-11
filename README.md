# vesting-management

Available Scripts
bulkCreateSchedules.js - Creates vesting schedules for multiple beneficiaries in batch.
checkSchedules.js - Verifies existing vesting schedules for specified wallet addresses.
Prerequisites
Node.js installed on your machine (v14+ recommended)
A Quai wallet with sufficient balance to cover the vesting amounts
Basic knowledge of running Node.js applications
Installation
Clone the repository:

git clone https://github.com/rileystephens28/vesting-management-tools.git
cd vesting-management-tools
Install dependencies:

npm install
Configuration
Environment Variables
Create a .env file in the root directory with the following variables:

RPC_URL=https://rpc.quai.network
PRIVATE_KEY=your_wallet_private_key
Replace your_wallet_private_key with the private key of the wallet that will be used to deploy vesting schedules.

Bulk Create Vesting Schedules
To use the bulkCreateSchedules.js script:

File Naming Convention and Directory Structure:

The script organizes files in a structured directory layout:

data/ - Contains input CSV files
records/ - Contains output record files
logs/ - Contains log files
These directories will be created automatically if they don't exist.

The script uses a specific file naming pattern based on the VESTING_ITERATION variable defined in the script. This allows you to run multiple iterations of vesting distributions while keeping files organized.

Input File: data/vesting_amounts{ITERATION}.csv (example: data/vesting_amounts3.csv)
Output Records: records/vesting_records_mainnet{ITERATION}.csv (example: records/vesting_records_mainnet3.csv)
Log File: logs/vesting_mainnet{ITERATION}.log (example: logs/vesting_mainnet3.log)
To use a different iteration number, modify the VESTING_ITERATION constant in bulkCreateSchedules.js.

Why Use Multiple Iterations?

Iterations are particularly useful when managing large numbers of vesting schedules. By using different iterations paired with different START_BLOCK_OFFSET_DAYS values, you can stagger the start and cliff dates of vesting schedules. This helps:

Avoid having all vesting schedules share the same cliff date, which could cause sell pressure
Organize beneficiaries into logical groups with different vesting timelines
Manage vesting deployments in smaller, more manageable batches
For example, iteration 1 might use a 0-day offset, iteration 2 a 7-day offset, and iteration 3 a 14-day offset, creating a staggered release schedule.

Create a CSV input file in the data directory with the following format:

wallet,total
0x1234567890123456789012345678901234567890,10000
0x0987654321098765432109876543210987654321,5000
The wallet column contains the beneficiary's Quai wallet address
The total column contains the total amount of Quai to be vested for that wallet
Configure vesting parameters in bulkCreateSchedules.js if needed:

VESTING_ITERATION - Current iteration number (affects all input/output file names)
START_BLOCK_OFFSET_DAYS - Days to delay start of vesting
VESTING_DURATION_DAYS - Total duration of vesting period (default 730 days)
CLIFF_PERIOD_DAYS - Cliff period where no tokens are released (default 180 days)
BATCH_SIZE - Number of beneficiaries to process in a single transaction
Check Vesting Schedules
To use the checkSchedules.js script:

Edit the ADDRESSES_TO_CHECK array in checkSchedules.js to include the wallet addresses you want to check:
const ADDRESSES_TO_CHECK = [
  "0x1234567890123456789012345678901234567890",
  "0x0987654321098765432109876543210987654321",
];
Running the Scripts
Bulk Create Vesting Schedules
Run the following command to bulk create vesting schedules for all addresses in the CSV file:

npm run bulk-create-schedules
Or directly:

node bulkCreateSchedules.js
The script will:

Read addresses and amounts from the CSV file (data/vesting_amounts{ITERATION}.csv)
Process beneficiaries in batches
Add vesting schedules to the contract
Record results in records/vesting_records_mainnet{ITERATION}.csv
Log detailed operations in logs/vesting_mainnet{ITERATION}.log
All file names are determined by the VESTING_ITERATION value in the script.

If the script is interrupted, it will automatically resume from where it left off when restarted.

Check Vesting Schedules
Run the following command to check vesting schedules:

npm run check-schedules
Or directly:

node checkSchedules.js
The script will display:

Whether each address has a vesting schedule
Total vesting amount
Released amount and percentage
Start block, cliff block, and end block information
Important Notes
Ensure your wallet has enough QUAI tokens to cover all vesting amounts
The scripts include retry mechanisms for failed transactions
Duplicate wallet addresses in the CSV file will be detected and reported
The script validates addresses before submitting transactions
For large batches, the process might take some time to complete
Vesting Parameters
The default vesting parameters are:

2 year (730 days) vesting duration
6 month (180 days) cliff period
Linear vesting after the cliff period
These parameters can be modified in the bulkCreateSchedules.js file.

Troubleshooting
If transactions are failing consistently, check your wallet balance and network connectivity
All errors are logged to the log file for debugging
The script will automatically retry failed transactions up to 10 times
Recovery
If the script crashes or is interrupted:

Simply restart the script using the same command
It will detect already processed wallets and continue from where it left off
Pending transactions will be monitored for completion
Potential Future Updates
Per-Beneficiary Vesting Schedule Customization
Currently, the vesting parameters (cliff period and duration) are set globally in the script. A potential enhancement would be to allow customization of these parameters for each beneficiary directly in the CSV file:

Extended CSV Format:

wallet,total,cliff_days,duration_days
0x1234567890123456789012345678901234567890,10000,180,730
0x0987654321098765432109876543210987654321,5000,90,365
0xabcdef1234567890abcdef1234567890abcdef12,20000,0,1095
Code Modifications Required:

Update the CSV parsing logic to extract the custom cliff and duration values
Modify the schedule creation to use per-beneficiary parameters
Add validation for the new fields
Update the batch processing to handle the variable parameters
Benefits:

Flexibility to create different vesting schedules for different beneficiary types (team, advisors, investors)
Ability to run a single batch for all beneficiaries regardless of schedule type
More granular control over token distribution timelines
Simplified operations by requiring fewer iterations of the script
This enhancement would make the vesting system more flexible while maintaining the batch processing efficiency of the current implementation.
