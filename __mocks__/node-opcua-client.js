// Jest manual mock for node-opcua-client
// Required because node-opcua's transitive deps (hexy) are ESM-only

const AttributeIds = {
  Value: 13,
  NodeId: 1,
  BrowseName: 3,
  DisplayName: 4,
  Description: 5,
  DataType: 14,
  EngineeringUnits: 2048,
  EngineeringUnitsRange: 2049,
};

const TimestampsToReturn = {
  Both: 2,
  Server: 1,
  Source: 0,
  Neither: 3,
};

const DataType = {
  Boolean: 1,
  SByte: 2,
  Byte: 3,
  Int16: 4,
  UInt16: 5,
  Int32: 6,
  UInt32: 7,
  Int64: 8,
  UInt64: 9,
  Float: 10,
  Double: 11,
  String: 12,
  DateTime: 13,
  Null: 0,
};

const SecurityPolicy = {
  None: 'http://opcfoundation.org/UA/SecurityPolicy#None',
  Basic128Rsa15: 'http://opcfoundation.org/UA/SecurityPolicy#Basic128Rsa15',
  Basic256: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256',
  Basic256Sha256: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
};

const MessageSecurityMode = {
  None: 1,
  Sign: 2,
  SignAndEncrypt: 3,
};

const UserTokenType = {
  Anonymous: 0,
  UserName: 1,
  Certificate: 2,
};

class OPCUACertificateManager {
  constructor() {}
}

class ClientMonitoredItemGroup {
  constructor() {}
}

class BrowsePath {
  constructor() {}
  static make() { return new BrowsePath(); }
}

class Variant {
  constructor(opts) {
    Object.assign(this, opts);
  }
}

function coerceNodeId(v) { return { toString: () => String(v) }; }
function resolveNodeId(v) { return { toString: () => String(v) }; }
function makeBrowsePath() { return new BrowsePath(); }
function uninstallAlarmMonitoring() {}

module.exports = {
  AttributeIds,
  TimestampsToReturn,
  DataType,
  SecurityPolicy,
  MessageSecurityMode,
  UserTokenType,
  OPCUACertificateManager,
  ClientMonitoredItemGroup,
  BrowsePath,
  Variant,
  coerceNodeId,
  resolveNodeId,
  makeBrowsePath,
  uninstallAlarmMonitoring,
};
