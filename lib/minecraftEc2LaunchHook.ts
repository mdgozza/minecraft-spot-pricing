// import * as util from 'util'
import axios from "axios";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

export interface Event {
  Records: Record[];
}

export interface Record {
  EventSource: string;
  EventVersion: string;
  EventSubscriptionArn: string;
  Sns: Sns;
}

export interface Sns {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject: string;
  Message: string;
  Timestamp: Date;
  SignatureVersion: string;
  Signature: string;
  SigningCertUrl: string;
  UnsubscribeUrl: string;
  MessageAttributes: {};
}

export async function handler(event: Event, context: any) {

  const { username, password, domain, provider } = process.env;

  if (provider === "google") {
    const ec2InstanceMessage = event.Records[0].Sns.Message;
    const ec2InstanceId = JSON.parse(ec2InstanceMessage).EC2InstanceId;

    try {
      const client = new EC2Client({
        region: "us-east-1",
        credentialDefaultProvider: defaultProvider,
      });
      const command = new DescribeInstancesCommand({
        InstanceIds: [ec2InstanceId],
      });
      const response = await client.send(command);
      const publicIp =
        response.Reservations?.[0]?.Instances?.[0].PublicIpAddress;
      if (publicIp) {
        const res = await axios.get(
          `https://${username}:${password}@domains.google.com/nic/update?hostname=${domain}&myip=${publicIp}`
        );
      }
    } catch (e) {
      console.log(e);
    }
  }

  return 200;
}
