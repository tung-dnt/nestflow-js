import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const dynamoDBClient = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });

export const DocumentClient = DynamoDBDocumentClient.from(dynamoDBClient, {
  marshallOptions: {
    // Specify your client options as usual
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
});
