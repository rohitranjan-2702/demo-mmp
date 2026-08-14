// produces message to kafka
import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "producer-x",
  brokers: [process.env.KAFKA_BROKER!],
});

export const kafkaProducer = kafka.producer();
