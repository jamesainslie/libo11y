# frozen_string_literal: true

require "digest"
require "securerandom"

module Libo11y
  module Internal
    module Identity
      INSTANCE_ID_NAMESPACE_BYTES = ["4d63009a8d0f11eeaad74c796ed8e320"].pack("H*").freeze

      module_function

      def uuid_v5(namespace_bytes, name)
        hash = Digest::SHA1.digest(namespace_bytes + name.encode(Encoding::UTF_8).b)
        bytes = hash.byteslice(0, 16).bytes
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        hex = bytes.pack("C*").unpack1("H*")
        "#{hex[0, 8]}-#{hex[8, 4]}-#{hex[12, 4]}-#{hex[16, 4]}-#{hex[20, 12]}"
      end

      def derive_instance_id(pod_uid: "", pod_name: "", namespace: "")
        return uuid_v5(INSTANCE_ID_NAMESPACE_BYTES, pod_uid) unless pod_uid.nil? || pod_uid.empty?
        return uuid_v5(INSTANCE_ID_NAMESPACE_BYTES, "#{namespace}/#{pod_name}") unless pod_name.nil? || pod_name.empty?

        nil
      end

      def random_instance_id
        SecureRandom.uuid
      end
    end
  end
end
