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
import { FileSystem } from "aws-cdk-lib/aws-efs";
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
  spotPrice: string;
  minecraftEnvVars?: { [key: string]: string };
  minecraftImageTag: string;
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
      maxAzs: 1,
      natGateways: 0, // this is not cheap and we don't want any
      subnetConfiguration: [
        { cidrMask: 23, name: "Public", subnetType: SubnetType.PUBLIC },
        {
          cidrMask: 23,
          name: "Private",
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const minecraftEbs = new Volume(this, "minecraft-ebs", {
      availabilityZone: vpc.availabilityZones[0],
      removalPolicy: RemovalPolicy.RETAIN,
      size: Size.gibibytes(10),
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
      awsCliPath = "/usr/local/bin";

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
      name: "minecraft",
      host: {
        sourcePath: "/opt/minecraft-ebs",
      },
    });

    const minecraftContainerDef = taskDef.addContainer(
      "minecraft-container-def",
      {
        image: ContainerImage.fromRegistry(
          `itzg/minecraft-server:${props.minecraftImageTag}`
        ),
        containerName: "minecraft-server",
        memoryReservationMiB: 1024,
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
      sourceVolume: "minecraft",
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
