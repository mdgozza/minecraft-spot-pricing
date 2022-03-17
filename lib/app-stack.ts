import { Duration, Stack, StackProps } from "aws-cdk-lib";
import {
  Vpc,
  SecurityGroup,
  Peer,
  Port,
  InstanceType,
  InstanceClass,
  InstanceSize,
  SubnetType,
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
  rconPort: string
}

export class Minecraft extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const vpc = new Vpc(this, "minecraft-vpc", {
      enableDnsHostnames: true,
      enableDnsSupport: true,
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

    const efsSecurityGroup = new SecurityGroup(this, "minecraft-efs-sg", {
      vpc,
    });
    efsSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(2049));

    const fileSystem = new FileSystem(this, "minecraft-efs", {
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_ISOLATED,
      },
      securityGroup: efsSecurityGroup,
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
    minecraftSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80))

    asg.addSecurityGroup(minecraftSecurityGroup);

    asg.userData.addCommands(

      // enable SSM agent for ssh through aws console
      "sudo systemctl enable amazon-ssm-agent",
      "sudo systemctl start amazon-ssm-agent",

      // mount shared efs for easy file inspecting and modifications
      "mkdir /opt/minecraft-efs",
      `mount -t efs ${fileSystem.fileSystemId} /opt/minecraft-efs/`,

      // install rcon tools for easy server level command running
      "sudo yum -y install wget",
      `wget "https://github.com/itzg/rcon-cli/releases/download/1.5.1/rcon-cli_1.5.1_linux_386.tar.gz" -P /usr/tmp`,
      "tar -xf /usr/tmp/rcon-cli_1.5.1_linux_386.tar.gz -C /usr/tmp",
      "sudo mv /usr/tmp/rcon-cli /usr/bin",
      "sudo chmod +x /usr/bin/rcon-cli",
      `alias rcon='rcon-cli --port ${props.rconPort} --password ${props.rconPassword}'`
    );

    asg.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
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
            ...props.domainSettings
          }
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
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
      },
      name: "minecraft",
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
            protocol: Protocol.TCP
          }
        ],
        environment: {
          EULA: "TRUE",
          ...props.minecraftEnvVars,
          RCON_PASSWORD: props.rconPassword,
          RCON_PORT: props.rconPort
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
