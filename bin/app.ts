#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Minecraft } from '../lib/app-stack';

const app = new cdk.App();
new Minecraft(app, 'Minecraft', {
    spotPrice: "0.0126", 
    minecraftImageTag: "latest",
    minecraftEnvVars: {
        TYPE: "PAPER"
    },
    domainSettings: {
        domain: "minecraft.gozza.dev",
        username: "",
        password: "",
        provider: "google"
    },
    rconPassword: "",
    rconPort: "25575"
});