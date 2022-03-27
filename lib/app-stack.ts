import { Duration, RemovalPolicy, Size, Stack, StackProps } from "aws-cdk-lib";
import {
  Vpc,
  SecurityGroup,
  Peer,
  Port,
  InstanceType,
  InstanceClass,
  InstanceSize,
  SubnetType,
  Volume,
  EbsDeviceVolumeType,
} from "aws-cdk-lib/aws-ec2";
import {
  AsgCapacityProvider,
  Cluster,
  Compatibility,
  ContainerImage,
  Ec2Service,
  EcsOptimizedImage,
  NetworkMode,
  Protocol,
  TaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import {
  AutoScalingGroup,
  DefaultResult,
  LifecycleTransition,
} from "aws-cdk-lib/aws-autoscaling";
import { ManagedPolicy } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { FunctionHook } from "aws-cdk-lib/aws-autoscaling-hooktargets";
import {
  attachAndMountEbs,
  enableSSMAgent,
  installAwsCli,
  installYumPackages,
} from "./utils/userDataCommands";

interface Props extends StackProps {
  /**
   * The max price you are willing to pay
   * for an EC2 Spot Instance to run.
   */
  spotPrice: string;
  /**
   * and ENV Vars you would like to pass down to the Minecraft
   * Docker Container Runtime. See https://github.com/itzg/docker-minecraft-server
   */
  minecraftEnvVars?: { [key: string]: string };
  /**
   * use this property to specify the version of java to run the minecraft server on
   * https://github.com/itzg/docker-minecraft-server#running-minecraft-server-on-different-java-version
   */
  minecraftImageTag: string;
  /**
   * If you would like every subsequent EC2 Launch to trigger
   * Google Domain DNS updates, specifiy the Google Domain properties here.
   * In the future we may support other Domain providers.
   */
  domainSettings?: {
    provider: "google";
    username: string;
    password: string;
    domain: string;
  };
  rconPassword: string;
  rconPort: string;
}

export class Minecraft extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const vpc = new Vpc(this, "minecraft-vpc", {
      enableDnsHostnames: true,
      enableDnsSupport: true,
      /**
       * We set maxAzs to one so that we can be sure that all
       * EC2s will launch in the same AZ. This way we can also be sure that
       * our later configured EBS volume will be in the correct AZ.
       */
      maxAzs: 1,
      /**
       * Nat Gateways are very expensive. btw.
       */
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 23, name: "Public", subnetType: SubnetType.PUBLIC },
        {
          cidrMask: 23,
          name: "Private",
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    /**
     * This is the EBS Volume that will contain our server files
     * it will persist against all costs in the AZ it is created.
     * and attached / re-attached on every instance creation.
     */

    const minecraftEbs = new Volume(this, "minecraft-ebs", {
      availabilityZone: vpc.availabilityZones[0],
      removalPolicy: RemovalPolicy.RETAIN,
      size: Size.gibibytes(10),
      volumeType: EbsDeviceVolumeType.GENERAL_PURPOSE_SSD_GP3
    });

    const asg = new AutoScalingGroup(this, "minecraft-asg", {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
      machineImage: EcsOptimizedImage.amazonLinux2(),
      desiredCapacity: 1, // change this to spin down
      maxCapacity: 1,
      minCapacity: 0,
      newInstancesProtectedFromScaleIn: true,
      spotPrice: props.spotPrice,
      associatePublicIpAddress: true,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
      },
    });

    const minecraftSecurityGroup = new SecurityGroup(this, "minecraft-sg", {
      vpc,
    });

    // allow minecraft client
    minecraftSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(25565));
    // allow http web ( mainly for dynmap )
    minecraftSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80));

    asg.addSecurityGroup(minecraftSecurityGroup);

    const deviceId = "/dev/xvdf",
      mountDir = "/opt/minecraft-ebs",
      awsCliPath = "/usr/local/bin",
      dockerVolumeName = "minecraft";

    asg.userData.addCommands(
      ...enableSSMAgent(),
      ...installYumPackages(["wget", "unzip"]),
      ...installAwsCli(awsCliPath),
      ...attachAndMountEbs({
        volumeId: minecraftEbs.volumeId,
        deviceId,
        mountDir,
        awsCliPath,
      })
    );

    asg.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    /**
     * I won't lie, this is egregious. We don't need EC2FullAccess
     * but I did not know the permissions required to attach EBS volumes to
     * EC2 so, I just went with this. We should find the correct permissions... 
     */
    asg.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2FullAccess")
    );

    if (props.domainSettings) {
      const minecraftEc2LaunchHandler = new NodejsFunction(
        this,
        "minecraft-ec2-launch-handler",
        {
          handler: "handler",
          entry: "./lib/minecraftEc2LaunchHook.ts",
          timeout: Duration.seconds(30),
          environment: {
            ...props.domainSettings,
          },
        }
      );

      minecraftEc2LaunchHandler.role?.addManagedPolicy(
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ReadOnlyAccess")
      );

      asg.addLifecycleHook("minecraft-ec2-launch-hook", {
        notificationTarget: new FunctionHook(minecraftEc2LaunchHandler),
        lifecycleTransition: LifecycleTransition.INSTANCE_LAUNCHING,
        defaultResult: DefaultResult.CONTINUE,
        heartbeatTimeout: Duration.seconds(30),
      });
    }

    const ecsCluster = new Cluster(this, "minecraft-cluster", {
      containerInsights: false,
      vpc,
    });

    const asgCapacityProvider = new AsgCapacityProvider(
      this,
      "minecraft-asg-capacity-provider",
      {
        autoScalingGroup: asg,
        targetCapacityPercent: 100,
        enableManagedScaling: true,
      }
    );

    ecsCluster.addAsgCapacityProvider(asgCapacityProvider);

    const taskDef = new TaskDefinition(this, "minecraft-task-def", {
      compatibility: Compatibility.EC2,
      networkMode: NetworkMode.BRIDGE,
    });

    taskDef.addVolume({
      name: dockerVolumeName,
      host: {
        sourcePath: mountDir,
      },
    });

    const minecraftContainerDef = taskDef.addContainer(
      "minecraft-container-def",
      {
        image: ContainerImage.fromRegistry(
          `itzg/minecraft-server:${props.minecraftImageTag}`
        ),
        containerName: "minecraft-server",
        memoryReservationMiB: 2560,
        portMappings: [
          {
            containerPort: 25565,
            hostPort: 25565,
            protocol: Protocol.TCP,
          },
          {
            containerPort: Number(props.rconPort),
            hostPort: Number(props.rconPort),
            protocol: Protocol.TCP,
          },
          {
            containerPort: 8123,
            hostPort: 80,
            protocol: Protocol.TCP,
          },
        ],
        environment: {
          EULA: "TRUE",
          ...props.minecraftEnvVars,
          RCON_PASSWORD: props.rconPassword,
          RCON_PORT: props.rconPort,
        },
      }
    );

    minecraftContainerDef.addMountPoints({
      containerPath: "/data",
      sourceVolume: dockerVolumeName,
      readOnly: false,
    });

    const service = new Ec2Service(this, "minecraft-ec2-service", {
      cluster: ecsCluster,
      taskDefinition: taskDef,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      capacityProviderStrategies: [
        {
          capacityProvider: asgCapacityProvider.capacityProviderName,
          weight: 1,
        },
      ],
    });
  }
}
