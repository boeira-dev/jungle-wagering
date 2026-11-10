#!/usr/bin/env bash
# LocalStack ready hook: create FIFO queues with a DLQ + redrive policy.
set -euo pipefail

DLQ="wager-transactions-dlq.fifo"
MAIN="wager-transactions.fifo"
EVENTS="wager-events.fifo"

create_simple_queue() {
  local name="$1"
  awslocal sqs create-queue \
    --queue-name "$name" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
}

create_simple_queue "$DLQ"

DLQ_URL=$(awslocal sqs get-queue-url --queue-name "$DLQ" --output text --query QueueUrl)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --output text --query Attributes.QueueArn)

# Use cli-input-json so the nested JSON RedrivePolicy is not mangled by the
# AWS CLI shorthand parser (which splits map values on commas).
cat > /tmp/jw-main-queue.json <<EOF
{
  "QueueName": "${MAIN}",
  "Attributes": {
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout": "5",
    "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"
  }
}
EOF

awslocal sqs create-queue --cli-input-json file:///tmp/jw-main-queue.json >/dev/null
create_simple_queue "$EVENTS"

echo "jungle-wagering queues ready"
