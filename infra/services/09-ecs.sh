#!/usr/bin/env bash
set -euo pipefail
# [9/9] ELB + ECS + Application Auto Scaling for this service (recorded in Floci: SIMULATED).
# Same approach as Lab 8 (09-elbv2.sh + 10-ecs.sh): Floci RECORDS the load balancer, the ECS service
# and the scaling rule, while real traffic is served by local Node.js processes (start-all.sh in
# roadhub-frontend) and the local gateway on :8080 plays the load balancer.
#
#   shared by the 3 services (made here only if missing): VPC 10.22.0.0/16, 2 subnets, security group
#     roadhub-sg, load balancer roadhub-alb with a listener on port 80, ECS cluster roadhub-cluster
#   this service: target group roadhub-engagement-tg (port 3002, health check /health), listener rules
#     for the engagement paths, task definition roadhub-engagement-task (256 CPU / 512 MB),
#     ECS service roadhub-engagement-service, Auto Scaling min 1 / max 4 / target 50% CPU
#
#   REPLICAS=3 bash infra/services/09-ecs.sh   records 3 running copies (ports 3002, 3012, 3022,
#   the ports start-all.sh uses), so what Floci shows matches what really runs.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"
# Desired count 0: Floci 2.5 runs ECS tasks as real Docker containers and there is no image to run (Lab 8: ECS is recorded only).
REPLICAS="${REPLICAS:-1}"
warn() { echo "  WARNING: $1 (recorded only on Floci; continuing)" >&2; }

echo "=== [9/9] ELB + ECS + Auto Scaling: roadhub-engagement-service (SIMULATED: recorded only) ==="

# ---- shared network: look first, create only if missing (Lab 8 09-elbv2.sh) ----
VPC_ID=$(awsl ec2 describe-vpcs --filters Name=cidr,Values=10.22.0.0/16 --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  VPC_ID=$(awsl ec2 create-vpc --cidr-block 10.22.0.0/16 --query 'Vpc.VpcId' --output text)
fi
subnet() { # subnet <cidr> <zone>
  local id
  id=$(awsl ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" Name=cidr-block,Values="$1" --query 'Subnets[0].SubnetId' --output text 2>/dev/null || true)
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    id=$(awsl ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block "$1" --availability-zone "$2" --query 'Subnet.SubnetId' --output text)
  fi
  echo "$id"
}
SUBNET_A=$(subnet 10.22.1.0/24 us-east-1a)
SUBNET_B=$(subnet 10.22.2.0/24 us-east-1b)
SG_ID=$(awsl ec2 describe-security-groups --filters Name=group-name,Values=roadhub-sg Name=vpc-id,Values="$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  SG_ID=$(awsl ec2 create-security-group --group-name roadhub-sg --description "RoadmapHub services" --vpc-id "$VPC_ID" --query GroupId --output text)
fi
echo "  network: $VPC_ID, subnets $SUBNET_A $SUBNET_B, security group $SG_ID"

ALB_ARN=$(awsl elbv2 describe-load-balancers --names roadhub-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN=$(awsl elbv2 create-load-balancer --name roadhub-alb --type application \
    --subnets "$SUBNET_A" "$SUBNET_B" --security-groups "$SG_ID" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
fi

# ---- this service's target group ----
TG_ARN=$(awsl elbv2 describe-target-groups --names roadhub-engagement-tg --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(awsl elbv2 create-target-group --name roadhub-engagement-tg --protocol HTTP --port 3002 \
    --vpc-id "$VPC_ID" --target-type ip --health-check-path /health --health-check-interval-seconds 10 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
fi
echo "  load balancer: roadhub-alb, target group: roadhub-engagement-tg"

LISTENER_ARN=$(awsl elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query 'Listeners[0].ListenerArn' --output text 2>/dev/null || true)
if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" = "None" ]; then
  LISTENER_ARN=$(awsl elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" --query 'Listeners[0].ListenerArn' --output text)
fi
# Path rules: these paths go to the engagement copies (same rules as the local gateway).
add_rule() { # add_rule <priority> <path patterns (comma list)>
  if ! awsl elbv2 describe-rules --listener-arn "$LISTENER_ARN" --query "Rules[?Priority=='$1'].RuleArn" --output text 2>/dev/null | grep -q arn; then
    awsl elbv2 create-rule --listener-arn "$LISTENER_ARN" --priority "$1" \
      --conditions "Field=path-pattern,PathPatternConfig={Values=[$2]}" --actions "Type=forward,TargetGroupArn=$TG_ARN" >/dev/null 2>&1 \
      || warn "listener rule $1 not created"
  fi
}
add_rule 20 '/api/features/*/votes*,/api/features/*/comments*,/api/comments*'
add_rule 21 '/api/me/votes*,/api/me/notifications*,/api/engagement/*'

# ---- ECS: cluster (shared), task definition and service (this service) ----
ok awsl ecs create-cluster --cluster-name roadhub-cluster || warn "create-cluster failed"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SERVICE_ROLE}"
CONTAINER_DEFS="[{\"name\":\"roadhub-engagement\",\"image\":\"roadhub-engagement:local\",\"portMappings\":[{\"containerPort\":3002,\"protocol\":\"tcp\"}],\"healthCheck\":{\"command\":[\"CMD-SHELL\",\"wget -qO- http://localhost:3002/health || exit 1\"]},\"logConfiguration\":{\"logDriver\":\"awslogs\",\"options\":{\"awslogs-group\":\"${APP_LOG_GROUP}\",\"awslogs-region\":\"us-east-1\",\"awslogs-stream-prefix\":\"engagement\"}}}]"
awsl ecs register-task-definition --family roadhub-engagement-task \
  --requires-compatibilities FARGATE --network-mode awsvpc --cpu 256 --memory 512 \
  --task-role-arn "$ROLE_ARN" --execution-role-arn "$ROLE_ARN" \
  --container-definitions "$CONTAINER_DEFS" >/dev/null 2>&1 || warn "register-task-definition failed"

EXISTING=$(awsl ecs describe-services --cluster roadhub-cluster --services roadhub-engagement-service --query 'services[0].serviceName' --output text 2>/dev/null || true)
if [ "$EXISTING" = "roadhub-engagement-service" ]; then
  awsl ecs update-service --cluster roadhub-cluster --service roadhub-engagement-service --desired-count 0 >/dev/null 2>&1 \
    || warn "update-service failed"
else
  awsl ecs create-service --cluster roadhub-cluster --service-name roadhub-engagement-service \
    --task-definition roadhub-engagement-task --desired-count 0 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_A},${SUBNET_B}],securityGroups=[${SG_ID}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${TG_ARN},containerName=roadhub-engagement,containerPort=3002" \
    >/dev/null 2>&1 || warn "create-service failed"
fi

awsl application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/roadhub-cluster/roadhub-engagement-service --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 --max-capacity 4 >/dev/null 2>&1 || warn "register-scalable-target failed"
awsl application-autoscaling put-scaling-policy --service-namespace ecs \
  --resource-id service/roadhub-cluster/roadhub-engagement-service --scalable-dimension ecs:service:DesiredCount \
  --policy-name roadhub-engagement-cpu-tracking --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{"TargetValue":50.0,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"}}' \
  >/dev/null 2>&1 || warn "put-scaling-policy failed"

# ---- record the copies that really run (start-all.sh ports 3002, 3012, 3022 ...) ----
for i in $(seq 0 $((REPLICAS - 1))); do
  awsl elbv2 register-targets --target-group-arn "$TG_ARN" --targets "Id=127.0.0.1,Port=$((3002 + i * 10))" >/dev/null 2>&1 \
    || warn "register-targets :$((3002 + i * 10)) failed"
done
echo "[9/9] done: roadhub-engagement-service (desired 0 on Floci, Node.js copies registered: $REPLICAS, scaling 1-4 at 50% CPU) - SIMULATED"
