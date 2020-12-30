import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import vpc from "./vpc";
import defaultLambdaRole from "./defaultLambdaRole";

// @ts-ignore
import { getLayerArn } from "@webiny/aws-layers";

class PageBuilder {
    functions: {
        render: aws.lambda.Function;
        flush: aws.lambda.Function;
        queue: {
            add: aws.lambda.Function;
            process: aws.lambda.Function;
        };
    };
    constructor({ env }: { env: Record<string, any> }) {
        const render = new aws.lambda.Function("ps-render", {
            role: defaultLambdaRole.role.arn,
            runtime: "nodejs12.x",
            handler: "handler.handler",
            timeout: 600,
            memorySize: 2048,
            layers: [
                getLayerArn("shelf-io-chrome-aws-lambda-layer", String(process.env.AWS_REGION))
            ],
            environment: {
                variables: {
                    ...env
                }
            },
            description: "Renders pages and stores output in an S3 bucket of choice.",
            code: new pulumi.asset.AssetArchive({
                ".": new pulumi.asset.FileArchive("./code/prerenderingService/render/build")
            }),
            vpcConfig: {
                subnetIds: vpc.subnets.private.map(subNet => subNet.id),
                securityGroupIds: [vpc.vpc.defaultSecurityGroupId]
            }
        });

        const flush = new aws.lambda.Function("ps-flush", {
            role: defaultLambdaRole.role.arn,
            runtime: "nodejs12.x",
            handler: "handler.handler",
            timeout: 30,
            memorySize: 512,
            environment: {
                variables: {
                    ...env
                }
            },
            description: "Flushes previously render pages.",
            code: new pulumi.asset.AssetArchive({
                ".": new pulumi.asset.FileArchive("./code/prerenderingService/flush/build")
            }),
            vpcConfig: {
                subnetIds: vpc.subnets.private.map(subNet => subNet.id),
                securityGroupIds: [vpc.vpc.defaultSecurityGroupId]
            }
        });

        const queueAdd = new aws.lambda.Function("ps-queue-add", {
            role: defaultLambdaRole.role.arn,
            runtime: "nodejs12.x",
            handler: "handler.handler",
            timeout: 30,
            memorySize: 512,
            environment: {
                variables: {
                    ...env
                }
            },
            description: "Adds a prerendering task to the prerendering queue.",
            code: new pulumi.asset.AssetArchive({
                ".": new pulumi.asset.FileArchive("./code/prerenderingService/queue/add/build")
            }),
            vpcConfig: {
                subnetIds: vpc.subnets.private.map(subNet => subNet.id),
                securityGroupIds: [vpc.vpc.defaultSecurityGroupId]
            }
        });

        const queueProcess = new aws.lambda.Function("ps-queue-process", {
            role: defaultLambdaRole.role.arn,
            runtime: "nodejs12.x",
            handler: "handler.handler",
            timeout: 900, // 15 minutes.
            memorySize: 4096,
            environment: {
                variables: {
                    ...env,
                    PRERENDERING_RENDER_HANDLER: render.arn,
                    PRERENDERING_FLUSH_HANDLER: flush.arn
                }
            },
            description: "Processes all jobs added to the prerendering queue.",
            code: new pulumi.asset.AssetArchive({
                ".": new pulumi.asset.FileArchive("./code/prerenderingService/queue/process/build")
            }),
            vpcConfig: {
                subnetIds: vpc.subnets.private.map(subNet => subNet.id),
                securityGroupIds: [vpc.vpc.defaultSecurityGroupId]
            }
        });

        this.functions = {
            render,
            flush,
            queue: {
                add: queueAdd,
                process: queueProcess
            }
        };
    }
}

export default PageBuilder;