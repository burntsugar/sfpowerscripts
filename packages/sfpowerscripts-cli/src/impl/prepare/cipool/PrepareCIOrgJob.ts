import InstallPackageDependenciesImpl from "@dxatscale/sfpowerscripts.core/lib/sfdxwrappers/InstallPackageDependenciesImpl";
import { PackageInstallationStatus } from "@dxatscale/sfpowerscripts.core/lib/package/PackageInstallationResult";
import DeployImpl, {
  DeploymentMode,
  DeployProps,
} from "../../deploy/DeployImpl";
import SFPLogger, {
  FileLogger,
  LoggerLevel,
} from "@dxatscale/sfpowerscripts.core/lib/logger/SFPLogger";
import { Stage } from "../../Stage";
import SFPStatsSender from "@dxatscale/sfpowerscripts.core/lib/stats/SFPStatsSender";
import InstallUnlockedPackageImpl from "@dxatscale/sfpowerscripts.core/lib/sfdxwrappers/InstallUnlockedPackageImpl";
import ScratchOrg from "../../pool/ScratchOrg";
import PoolJobExecutor, {
  JobError,
  ScriptExecutionResult,
} from "../../pool/PoolJobExecutor";
import { Org } from "@salesforce/core";
import ProjectConfig from "@dxatscale/sfpowerscripts.core/lib/project/ProjectConfig";
import { PoolConfig } from "../../pool/PoolConfig";
import { Result, ok, err } from "neverthrow";

const SFPOWERSCRIPTS_ARTIFACT_PACKAGE = "04t1P000000ka9mQAA";
export default class PrepareCIOrgJob extends PoolJobExecutor {
  private checkPointPackages: string[];

  public constructor(protected pool: PoolConfig) {
    super(pool);
  }

  async executeJob(
    scratchOrg: ScratchOrg,
    hubOrg: Org,
    logToFilePath: string
  ): Promise<Result<ScriptExecutionResult, JobError>> {
    //Install sfpowerscripts Artifact

    try {
      
      let packageLogger: FileLogger = new FileLogger(logToFilePath);
      this.checkPointPackages = this.getcheckPointPackages(packageLogger);

      SFPLogger.log(
        `Installing sfpowerscripts_artifact package to the ${scratchOrg.alias}`,
        null,
        packageLogger
      );

      let installUnlockedPackageImpl: InstallUnlockedPackageImpl = new InstallUnlockedPackageImpl(
        null,
        scratchOrg.username,
        process.env.SFPOWERSCRIPTS_ARTIFACT_PACKAGE
          ? process.env.SFPOWERSCRIPTS_ARTIFACT_PACKAGE
          : SFPOWERSCRIPTS_ARTIFACT_PACKAGE,
        "60"
      );

      await installUnlockedPackageImpl.exec(true);

      SFPLogger.log(
        `Installing package depedencies to the ${scratchOrg.alias}`,
        LoggerLevel.INFO,
        packageLogger
      );
      SFPLogger.log(
        `Installing Package Dependencies of this repo in ${scratchOrg.alias}`
      );

      // Install Dependencies
      let installDependencies: InstallPackageDependenciesImpl = new InstallPackageDependenciesImpl(
        scratchOrg.username,
        hubOrg.getUsername(),
        120,
        null,
        this.pool.keys,
        true,
        packageLogger
      );
      let installationResult = await installDependencies.exec();
      if (installationResult.result == PackageInstallationStatus.Failed) {
        throw new Error(installationResult.message);
      }

      SFPLogger.log(
        `Successfully completed Installing Package Dependencies of this repo in ${scratchOrg.alias}`
      );

      if (this.pool.cipool.installAll) {
        let deploymentResult = await this.deployAllPackagesInTheRepo(
          scratchOrg,
          packageLogger
        );
        this.pool.succeedOnDeploymentErrors
          ? this.handleDeploymentErrorsForPartialDeployment(
              scratchOrg,
              deploymentResult,
              packageLogger
            )
          : this.handleDeploymentErrorsForFullDeployment(
              scratchOrg,
              deploymentResult,
              packageLogger
            );
      }

      return ok({ scratchOrgUsername: scratchOrg.username });
    } catch (error) {
      return err({
        message: error.message,
        scratchOrgUsername: scratchOrg.username,
      });
    }
  }

  private async deployAllPackagesInTheRepo(
    scratchOrg: ScratchOrg,
    packageLogger: any
  ) {
    SFPLogger.log(`Deploying all packages in the repo to  ${scratchOrg.alias}`);
    SFPLogger.log(
      `Deploying all packages in the repo to  ${scratchOrg.alias}`,
      LoggerLevel.INFO,
      packageLogger
    );

    let deployProps: DeployProps = {
      targetUsername: scratchOrg.username,
      artifactDir: "artifacts",
      waitTime: 120,
      currentStage: Stage.PREPARE,
      packageLogger: packageLogger,
      isTestsToBeTriggered: false,
      skipIfPackageInstalled: false,
      deploymentMode: this.pool.cipool.installAsSourcePackages
        ? DeploymentMode.SOURCEPACKAGES
        : DeploymentMode.NORMAL,
      isRetryOnFailure: this.pool.cipool.retryOnFailure,
    };

    //Deploy the fetched artifacts to the org
    let deployImpl: DeployImpl = new DeployImpl(deployProps);

    let deploymentResult = await deployImpl.exec();

    return deploymentResult;
  }

  private handleDeploymentErrorsForFullDeployment(
    scratchOrg: ScratchOrg,
    deploymentResult: {
      deployed: string[];
      failed: string[];
      testFailure: string;
      error: any;
    },
    packageLogger: any
  ) {
    //Handle Deployment Failures
    if (deploymentResult.failed.length > 0 || deploymentResult.error) {
      //Write to Scratch Org Logs
      SFPLogger.log(
        `Following Packages failed to deploy in ${scratchOrg.alias}`,
        LoggerLevel.INFO,
        packageLogger
      );
      SFPLogger.log(
        JSON.stringify(deploymentResult.failed),
        LoggerLevel.INFO,
        packageLogger
      );
      SFPLogger.log(
        `Deployment of packages failed in ${scratchOrg.alias}, this scratch org will be deleted`,
        LoggerLevel.INFO,
        packageLogger
      );
      throw new Error(
        "Following Packages failed to deploy:" + deploymentResult.failed
      );
    }
  }

  private handleDeploymentErrorsForPartialDeployment(
    scratchOrg: ScratchOrg,
    deploymentResult: {
      deployed: string[];
      failed: string[];
      testFailure: string;
      error: any;
    },
    packageLogger: any
  ) {
    //Handle Deployment Failures
    if (deploymentResult.failed.length > 0 || deploymentResult.error) {
      if (this.checkPointPackages.length > 0) {
        let isCheckPointSucceded = this.checkPointPackages.some((pkg) =>
          deploymentResult.deployed.includes(pkg)
        );
        if (!isCheckPointSucceded) {
          SFPStatsSender.logCount("prepare.org.checkpointfailed");
          SFPLogger.log(
            `One or some of the check point packages ${this.checkPointPackages} failed to deploy, Deleting ${scratchOrg.alias}`,
            LoggerLevel.INFO,
            packageLogger
          );
          throw new Error(
            `One or some of the check point Packages ${this.checkPointPackages} failed to deploy`
          );
        }
      } else {
        SFPStatsSender.logCount("prepare.org.partial");
        SFPLogger.log(
          `Cancelling any further packages to be deployed, Adding the scratchorg ${scratchOrg.alias} to the pool`,
          LoggerLevel.INFO,
          packageLogger
        );
      }
    }
  }

  //Fetch all checkpoints
  private getcheckPointPackages(logger:FileLogger) {
    SFPLogger.log("Fetching checkpoints for prepare if any.....",LoggerLevel.INFO,logger);
    let projectConfig = ProjectConfig.getSFDXPackageManifest(null);
    let checkPointPackages = [];
    projectConfig["packageDirectories"].forEach((pkg) => {
      if (pkg.checkpointForPrepare) checkPointPackages.push(pkg["package"]);
    });
    return checkPointPackages;
  }
}
