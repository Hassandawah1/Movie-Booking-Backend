const mongoose = require("mongoose")
const bcrypt = require("bcryptjs")
require("dotenv").config()
const dns = require("dns")
try {
  dns.setServers(["8.8.8.8", "8.8.4.4"])
} catch (e) {
  
}


mongoose.set('debug', true)

const User = require("../models/User.model")


const requiredEnvVars = ["ADMIN_NAME", "ADMIN_EMAIL", "ADMIN_PASSWORD", "MONGODB_URI", "JWT_SECRET"]
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`)
    process.exit(1)
  }
}


const uri = process.env.MONGODB_URI
if (uri) {
  
  const uriWithoutCreds = uri.replace(/:\/\/[^@]+@/, "://****@")
  console.log(`Using MONGODB_URI: ${uriWithoutCreds}`)
}

const adminName = process.env.ADMIN_NAME.trim()
const adminEmail = process.env.ADMIN_EMAIL.toLowerCase().trim()
const adminPassword = process.env.ADMIN_PASSWORD

if (!adminName || !adminEmail || !adminPassword) {
  console.error("Admin name, email, and password must not be empty after trimming")
  process.exit(1)
}

if (adminPassword.length < 6) {
  console.error("Admin password must be at least 6 characters long")
  process.exit(1)
}

function seedAdmin() {
  return new Promise((resolve, reject) => {
    
    setTimeout(() => {
      mongoose.connect(process.env.MONGODB_URI, {
        maxPoolSize: 10,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      })
      .then(() => {
        console.log("Connected to MongoDB for admin seeding...")
        
        return seedAdminLogic()
      })
      .then((success) => {
        
        console.log("\n✅ Admin seeding completed successfully")
        
        if (mongoose.connection) {
          mongoose.disconnect()
          console.log("MongoDB connection closed")
        }
        resolve(success)
      })
      .catch((err) => {
        console.error("❌ Admin seeding failed:", err.message)
        
        
        if (mongoose.connection) {
          mongoose.disconnect()
          console.log("MongoDB connection closed")
        }
        resolve(false)
      })
    }, 3000)
  })
}

async function seedAdminLogic() {
  try {
    
    const normalizedEmail = adminEmail.toLowerCase().trim()

    
    const existingUser = await User.findOne({ email: normalizedEmail })

    if (existingUser) {
      
      if (existingUser.role !== "admin") {
        console.log(`User ${normalizedEmail} exists but role is '${existingUser.role}'. Updating to 'admin'...`)
        existingUser.role = "admin"
        await existingUser.save()
        console.log(`✓ User ${normalizedEmail} role updated to admin`)
      } else {
        console.log(`✓ Admin user ${normalizedEmail} already exists with correct role`)
      }

      
      
      console.log("ℹ️  Password for existing admin user left unchanged (for security)")
    } else {
      
      console.log(`Creating new admin user: ${normalizedEmail}`)

      
      const hashedPassword = await bcrypt.hash(adminPassword, 10)

      const adminUser = await User.create({
        name: adminName,
        email: normalizedEmail,
        password: hashedPassword,
        role: "admin"
      })

      console.log(`✓ Admin user created successfully:`)
      console.log(`  ID: ${adminUser._id}`)
      console.log(`  Name: ${adminUser.name}`)
      console.log(`  Email: ${adminUser.email}`)
      console.log(`  Role: ${adminUser.role}`)
      console.log("⚠️  Please change your password on first login for security")
    }

    return true
  } catch (error) {
    console.error("❌ Error in seedAdminLogic:", error.message)
    return false
  }
}


seedAdmin()
  .then(success => {
    process.exit(success ? 0 : 1)
  })
  .catch(error => {
    console.error("❌ Unexpected error during admin seeding:", error.message)
    process.exit(1)
  })