type EbsMountOptions = {
  volumeId: string;
  deviceId: string;
  mountDir: string;
  awsCliPath: string;
};
type RconCliInstallOptions = {
  rconPort: string;
  rconPassword: string;
};

export function installAwsCli(cliPath: string) {
  return [
    `curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"`,
    `unzip awscliv2.zip`,
    `sudo ./aws/install -i /usr/local/aws-cli -b ${cliPath}`,
  ];
}

export function installYumPackages(packages: string[]) {
  return [`sudo yum install -y ${packages.join(" ")}`];
}

export function attachAndMountEbs({
  deviceId,
  volumeId,
  mountDir,
  awsCliPath,
}: EbsMountOptions) {
  return [
    `export INSTANCE_ID=$(wget -q -O - http://169.254.169.254/latest/meta-data/instance-id)`,
    `mkdir ${mountDir}`,
    `${awsCliPath}/aws ec2 attach-volume --volume-id ${volumeId} --instance-id $INSTANCE_ID --device ${deviceId}`,
    `while [[ ! -e ${deviceId} ]]; do sleep 2; done`,
    `mount ${deviceId} ${mountDir}`,
  ];
}

export function enableSSMAgent() {
  return [
    "sudo systemctl enable amazon-ssm-agent",
    "sudo systemctl start amazon-ssm-agent",
  ];
}

export function installRconCli({
  rconPassword,
  rconPort,
}: RconCliInstallOptions) {
  return [
    `wget "https://github.com/itzg/rcon-cli/releases/download/1.5.1/rcon-cli_1.5.1_linux_386.tar.gz" -P /usr/tmp`,
    "tar -xf /usr/tmp/rcon-cli_1.5.1_linux_386.tar.gz -C /usr/tmp",
    "sudo mv /usr/tmp/rcon-cli /usr/bin",
    "sudo chmod +x /usr/bin/rcon-cli",
    `alias rcon='rcon-cli --port ${rconPort} --password ${rconPassword}'`,
  ];
}
